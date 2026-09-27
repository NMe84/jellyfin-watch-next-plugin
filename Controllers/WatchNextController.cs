using System;
using System.Collections.Generic;
using System.Linq;
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
    private readonly WatchNextStore _store;

    public WatchNextController(ILibraryManager libraryManager, WatchNextStore store)
    {
        _libraryManager = libraryManager;
        _store = store;
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
    /// Maps stored ids to display data, preserving list order and collecting
    /// anything that no longer resolves.
    ///
    /// Property names are spelled in camelCase explicitly through an anonymous
    /// type: Jellyfin serialises API responses with System.Text.Json using its
    /// own naming policy, and the client should not have to care which one is
    /// in effect.
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

            result.Add(new
            {
                id = item.Id.ToString("N"),
                name = item.Name,
                year = item.ProductionYear,
                type = item.GetType().Name,
                hasImage = item.HasImage(ImageType.Primary),
                hasThumb = item.HasImage(ImageType.Thumb)
            });
        }

        return result;
    }
}
