using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.WatchNext.Models;
using Jellyfin.Plugin.WatchNext.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.WatchNext.Controllers;

/// <summary>
/// The per-user API behind the Watch Next page.
///
/// Everything here is plain [Authorize] rather than RequiresElevation: these
/// lists belong to ordinary users, and each request only ever touches the list
/// of the user the token belongs to. The user id is taken from the token's
/// claims, never from a parameter, so one user cannot read or edit another's
/// list.
/// </summary>
[ApiController]
[Authorize]
[Route("WatchNext")]
[Produces("application/json")]
public class WatchNextController : ControllerBase
{
    /// <summary>
    /// The claim Jellyfin puts the authenticated user's id in. Hardcoded rather
    /// than referenced from Jellyfin.Api.Constants, because Jellyfin.Api is not
    /// published as a NuGet package for plugins to compile against.
    /// </summary>
    private const string UserIdClaim = "Jellyfin-UserId";

    private const string ClientScriptResource = "Jellyfin.Plugin.WatchNext.Web.client.js";

    private readonly ILibraryManager _libraryManager;
    private readonly IUserManager _userManager;
    private readonly WatchNextStore _store;
    private readonly ILogger<WatchNextController> _logger;

    public WatchNextController(
        ILibraryManager libraryManager,
        IUserManager userManager,
        WatchNextStore store,
        ILogger<WatchNextController> logger)
    {
        _libraryManager = libraryManager;
        _userManager = userManager;
        _store = store;
        _logger = logger;
    }

    /// <summary>
    /// Serves the user-facing client script.
    ///
    /// Anonymous by necessity: this is loaded through a &lt;script src&gt; tag,
    /// which cannot carry an authorization header. It contains no user data -
    /// every call the script makes is itself authenticated.
    /// </summary>
    [HttpGet("client.js")]
    [AllowAnonymous]
    [Produces("application/javascript")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult GetClientScript()
    {
        var stream = GetType().Assembly.GetManifestResourceStream(ClientScriptResource);
        if (stream is null)
        {
            return NotFound();
        }

        return File(stream, "application/javascript; charset=utf-8");
    }

    /// <summary>Settings the client needs in order to render itself.</summary>
    [HttpGet("Config")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<object> GetClientConfig()
    {
        var config = Plugin.Instance?.Configuration;
        return Ok(new
        {
            menuLabel = string.IsNullOrWhiteSpace(config?.MenuLabel) ? "Watch Next" : config!.MenuLabel,
            showMenuItem = config?.ShowMenuItem ?? true
        });
    }

    /// <summary>
    /// Returns the calling user's two lists, in order, resolved to something
    /// the client can render. Entries whose media has since been deleted are
    /// dropped from storage on the way out.
    /// </summary>
    [HttpGet("List")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<object> GetList()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        var lists = _store.Get(userId);
        var missing = new List<Guid>();

        var movies = Resolve(lists.Movies, missing);
        var series = Resolve(lists.Series, missing);

        _store.Prune(userId, missing);

        return Ok(new { movies, series });
    }

    /// <summary>
    /// How many exact-title hits to look up. More than one because a movie and
    /// a show can share a title.
    /// </summary>
    private const int ExactMatchLimit = 10;

    /// <summary>How many unaddable-but-matching items to report back per search.</summary>
    private const int ExplainedExclusions = 8;

    /// <summary>
    /// Only relevant matches are worth explaining. A title the term merely
    /// appears inside ("Edward" for "war") is noise; one that is the title, or
    /// starts it, or starts a word in it ("Star Wars") is what was searched for.
    /// </summary>
    private const int ExplainableRank = 2;

    /// <summary>
    /// Searches the library for movies and shows the user could add.
    ///
    /// Searching runs here rather than against /Items in the browser so that
    /// "already watched" is decided in exactly one place, and so the UI cannot
    /// offer something the add would only reject.
    ///
    /// Matches that cannot be added are not dropped silently - a few of them
    /// come back carrying the reason. Dropping them made the feature look
    /// broken: searching for a show you had started returned a page of titles
    /// that merely contained the same letters, with no sign of the one you
    /// actually asked for.
    /// </summary>
    [HttpGet("Search")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<object> Search([FromQuery] string? term, [FromQuery] int limit = 20)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        var user = _userManager.GetUserById(userId);
        if (user is null)
        {
            return Unauthorized();
        }

        if (string.IsNullOrWhiteSpace(term))
        {
            return Ok(Array.Empty<object>());
        }

        var lists = _store.Get(userId);
        var listed = new HashSet<Guid>(lists.Movies.Concat(lists.Series));

        var types = new[] { BaseItemKind.Movie, BaseItemKind.Series };

        var search = new InternalItemsQuery(user)
        {
            SearchTerm = term,
            IncludeItemTypes = types,
            Recursive = true,
            // Ask for more than we return, since some matches turn out to be
            // unaddable and that must not empty a page of otherwise good hits.
            Limit = Math.Max(limit, 20) * 4
        };

        // An item whose title IS what was typed is looked up directly as well,
        // rather than trusting it to surface out of the search above. That query
        // is capped and ordered by Jellyfin's own relevance scoring, neither of
        // which this plugin controls, and a short title like "WAR" competes with
        // every "Warrior" and "Edward" in the library for those slots.
        //
        // It runs twice because Jellyfin matches names two different ways: the
        // default compares a normalised CleanName, while UseRawName compares the
        // stored title. An item whose CleanName was never filled in is invisible
        // to the first and to the search above, but still found by the second.
        var candidates = Lookup(new InternalItemsQuery(user)
            {
                Name = term,
                IncludeItemTypes = types,
                Recursive = true,
                Limit = ExactMatchLimit
            })
            .Concat(Lookup(new InternalItemsQuery(user)
            {
                Name = term,
                UseRawName = true,
                IncludeItemTypes = types,
                Recursive = true,
                Limit = ExactMatchLimit
            }))
            .Concat(Lookup(search))
            .DistinctBy(item => item.Id)
            .OrderBy(item => Rank(item.Name, term))
            .ThenBy(item => item.Name, StringComparer.CurrentCultureIgnoreCase);

        var addable = new List<SearchHit>();
        var excluded = new List<SearchHit>();

        foreach (var item in candidates)
        {
            if (addable.Count >= limit && excluded.Count >= ExplainedExclusions)
            {
                break;
            }

            var rank = Rank(item.Name, term);
            var reason = ExclusionReason(item, user, listed);

            if (reason is null)
            {
                if (addable.Count < limit)
                {
                    addable.Add(new SearchHit(rank, false, item.Name ?? string.Empty, ToSearchDto(item, null)));
                }
            }
            else if (excluded.Count < ExplainedExclusions && rank <= ExplainableRank)
            {
                excluded.Add(new SearchHit(rank, true, item.Name ?? string.Empty, ToSearchDto(item, reason)));
            }
        }

        // Relevance decides the order, and only within one tier does an addable
        // hit come before an explained one. So the title actually searched for
        // leads even when it cannot be added - appending the explained hits
        // instead buried an exact match behind twenty incidental ones, which is
        // the same invisibility as dropping it.
        return Ok(addable.Concat(excluded)
            .OrderBy(hit => hit.Rank)
            .ThenBy(hit => hit.Blocked)
            .ThenBy(hit => hit.Name, StringComparer.CurrentCultureIgnoreCase)
            .Select(hit => hit.Dto)
            .ToList());
    }

    /// <summary>One search hit, with what is needed to order it.</summary>
    private sealed record SearchHit(int Rank, bool Blocked, string Name, object Dto);

    /// <summary>
    /// Runs a library query, treating a failure as "no matches" rather than
    /// failing the whole search. The exact-title lookups are belt and braces
    /// for the substring search and must not be able to break it.
    /// </summary>
    private IReadOnlyList<BaseItem> Lookup(InternalItemsQuery query)
    {
        try
        {
            return _libraryManager.GetItemList(query);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "WatchNext: a library search query failed");
            return Array.Empty<BaseItem>();
        }
    }

    /// <summary>
    /// Why this item cannot be added, or null when it can be.
    /// </summary>
    private string? ExclusionReason(BaseItem item, User user, HashSet<Guid> listed)
    {
        if (listed.Contains(item.Id))
        {
            return "Already on your list";
        }

        if (IsWatched(item, user))
        {
            return item is Series ? "Already started watching" : "Already watched";
        }

        return null;
    }

    /// <summary>Adds a movie or series to the bottom of the matching list.</summary>
    [HttpPost("Items/{itemId}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<object> AddItem([FromRoute] Guid itemId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        var user = _userManager.GetUserById(userId);
        if (user is null)
        {
            return Unauthorized();
        }

        var item = _libraryManager.GetItemById(itemId);
        if (item is null)
        {
            return NotFound();
        }

        var kind = KindOf(item);
        if (kind is null)
        {
            return BadRequest("Only movies and shows can be added to a Watch Next list.");
        }

        // The list is about what to watch next, so something already watched can
        // never belong on it. The client filters these out of its search results
        // too; this is the authoritative check.
        if (IsWatched(item, user))
        {
            return BadRequest(kind == WatchNextKind.Series
                ? "You have already started watching this show."
                : "You have already watched this movie.");
        }

        var added = _store.Add(userId, itemId, kind.Value);
        return Ok(new { added, kind = kind.Value.ToString() });
    }

    /// <summary>Removes an item from whichever list holds it.</summary>
    [HttpDelete("Items/{itemId}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<object> RemoveItem([FromRoute] Guid itemId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        return Ok(new { removed = _store.Remove(userId, itemId) });
    }

    /// <summary>Stores a new order for one of the two lists after a drag.</summary>
    [HttpPost("Order")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public ActionResult SetOrder([FromBody] ReorderRequest request)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        if (!Enum.TryParse<WatchNextKind>(request.Kind, true, out var kind))
        {
            return BadRequest("Kind must be either Movie or Series.");
        }

        _store.SetOrder(userId, kind, request.Ids);
        return NoContent();
    }

    private Guid GetUserId()
    {
        var value = User.FindFirst(UserIdClaim)?.Value;
        return Guid.TryParse(value, out var userId) ? userId : Guid.Empty;
    }

    private static WatchNextKind? KindOf(BaseItem item) => item switch
    {
        Movie => WatchNextKind.Movie,
        Series => WatchNextKind.Series,
        _ => null
    };

    /// <summary>
    /// Search relevance, lowest first: the whole title, then a title starting
    /// with the term, then the term appearing as its own word, then anything
    /// else that merely contains those letters. Without the first tier a short
    /// title like "WAR" sits among every "Warrior" and "Edward" in the library.
    /// </summary>
    private static int Rank(string? name, string term)
    {
        if (name is null)
        {
            return 3;
        }

        if (string.Equals(name, term, StringComparison.CurrentCultureIgnoreCase))
        {
            return 0;
        }

        if (name.StartsWith(term, StringComparison.CurrentCultureIgnoreCase))
        {
            return 1;
        }

        var index = name.IndexOf(term, StringComparison.CurrentCultureIgnoreCase);
        return index > 0 && !char.IsLetterOrDigit(name[index - 1]) ? 2 : 3;
    }

    /// <summary>
    /// Whether this user is done with the item for Watch Next purposes.
    ///
    /// A movie counts as watched once it is marked played. A show counts as soon
    /// as ANY single episode is played - the list answers "what do I start
    /// next", so a show already begun is no longer a candidate. That matches
    /// what the auto-removal service does when an episode finishes.
    ///
    /// Both answers come from a library query rather than from
    /// IUserDataManager.GetUserData. In Jellyfin 12 that method does not read
    /// the database: it inspects the UserData already attached to the entity,
    /// which is only populated for items materialised through a user-scoped
    /// query. An item fetched with GetItemById therefore always looks unwatched.
    /// </summary>
    private bool IsWatched(BaseItem item, User user)
    {
        var query = new InternalItemsQuery(user)
        {
            IsPlayed = true,
            Limit = 1
        };

        if (item is Series series)
        {
            query.AncestorIds = new[] { series.Id };
            query.IncludeItemTypes = new[] { BaseItemKind.Episode };
            query.Recursive = true;
        }
        else
        {
            query.ItemIds = new[] { item.Id };
        }

        return _libraryManager.GetItemList(query).Count > 0;
    }

    /// <summary>
    /// Property names are spelled in camelCase explicitly through an anonymous
    /// type: Jellyfin serialises API responses with System.Text.Json using its
    /// own naming policy, and the client should not have to care which one is
    /// in effect.
    /// </summary>
    private static object ToDto(BaseItem item) => new
    {
        id = item.Id.ToString("N"),
        name = item.Name,
        year = item.ProductionYear,
        type = item.GetType().Name,
        hasImage = item.HasImage(ImageType.Primary),
        hasThumb = item.HasImage(ImageType.Thumb)
    };

    /// <summary>
    /// A search hit, carrying the reason it cannot be added when there is one.
    /// </summary>
    private static object ToSearchDto(BaseItem item, string? reason) => new
    {
        id = item.Id.ToString("N"),
        name = item.Name,
        year = item.ProductionYear,
        type = item.GetType().Name,
        hasImage = item.HasImage(ImageType.Primary),
        hasThumb = item.HasImage(ImageType.Thumb),
        reason
    };

    /// <summary>
    /// Maps stored ids to display data, preserving list order and collecting
    /// anything that no longer resolves.
    /// </summary>
    private List<object> Resolve(IEnumerable<Guid> ids, List<Guid> missing)
    {
        var result = new List<object>();

        foreach (var id in ids)
        {
            var item = _libraryManager.GetItemById(id);
            if (item is null)
            {
                missing.Add(id);
                continue;
            }

            result.Add(ToDto(item));
        }

        return result;
    }
}
