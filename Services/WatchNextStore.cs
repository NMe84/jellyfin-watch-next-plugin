using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.WatchNext.Models;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.WatchNext.Services;

/// <summary>
/// Persists every user's two ordered lists.
///
/// The lists live in a single JSON file under the server's data directory
/// rather than in the plugin configuration, for two reasons: they are user
/// data rather than admin settings, and the plugin's own data folder is
/// version-stamped, so it would be wiped on every plugin update.
///
/// Everything is held in memory and written through on each change; the data
/// set is a handful of GUIDs per user, so this stays cheap.
/// </summary>
public sealed class WatchNextStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new JsonSerializerOptions
    {
        WriteIndented = true
    };

    private readonly ILogger<WatchNextStore> _logger;
    private readonly string _filePath;
    private readonly object _lock = new object();

    private Dictionary<Guid, UserLists> _data = new Dictionary<Guid, UserLists>();

    public WatchNextStore(IApplicationPaths applicationPaths, ILogger<WatchNextStore> logger)
    {
        _logger = logger;

        var directory = Path.Combine(applicationPaths.DataPath, "watchnext");
        Directory.CreateDirectory(directory);
        _filePath = Path.Combine(directory, "lists.json");

        Load();
    }

    /// <summary>Returns a snapshot of one user's lists. Never null.</summary>
    public UserLists Get(Guid userId)
    {
        lock (_lock)
        {
            if (!_data.TryGetValue(userId, out var lists))
            {
                return new UserLists();
            }

            return new UserLists
            {
                Movies = new List<Guid>(lists.Movies),
                Series = new List<Guid>(lists.Series)
            };
        }
    }

    /// <summary>
    /// Appends an item to the bottom of the matching list. Adding at the bottom
    /// rather than the top keeps whatever the user deliberately queued up next
    /// in place. No-op if the item is already listed.
    /// </summary>
    public bool Add(Guid userId, Guid itemId, WatchNextKind kind)
    {
        lock (_lock)
        {
            var lists = GetOrCreate(userId);
            var list = lists.For(kind);
            if (list.Contains(itemId))
            {
                return false;
            }

            list.Add(itemId);
            Save();
            return true;
        }
    }

    /// <summary>
    /// Removes an item from whichever of the user's lists holds it.
    /// </summary>
    public bool Remove(Guid userId, Guid itemId)
    {
        lock (_lock)
        {
            if (!_data.TryGetValue(userId, out var lists))
            {
                return false;
            }

            var removed = lists.Movies.Remove(itemId) | lists.Series.Remove(itemId);
            if (removed)
            {
                Save();
            }

            return removed;
        }
    }

    /// <summary>
    /// Replaces the order of one list. Ids that are not currently in the list
    /// are ignored; ids that are in the list but missing from the request keep
    /// their relative order at the bottom, so a stale client cannot silently
    /// drop entries.
    /// </summary>
    public void SetOrder(Guid userId, WatchNextKind kind, IEnumerable<Guid> ids)
    {
        lock (_lock)
        {
            var lists = GetOrCreate(userId);
            var current = lists.For(kind);

            var reordered = ids.Where(id => current.Contains(id)).Distinct().ToList();
            reordered.AddRange(current.Where(id => !reordered.Contains(id)));

            current.Clear();
            current.AddRange(reordered);
            Save();
        }
    }

    /// <summary>
    /// Drops ids that no longer resolve to a library item, so deleted media
    /// does not linger as a ghost row.
    /// </summary>
    public void Prune(Guid userId, ICollection<Guid> missing)
    {
        if (missing.Count == 0)
        {
            return;
        }

        lock (_lock)
        {
            if (!_data.TryGetValue(userId, out var lists))
            {
                return;
            }

            var changed = lists.Movies.RemoveAll(missing.Contains) > 0;
            changed |= lists.Series.RemoveAll(missing.Contains) > 0;
            if (changed)
            {
                Save();
            }
        }
    }

    private UserLists GetOrCreate(Guid userId)
    {
        if (!_data.TryGetValue(userId, out var lists))
        {
            lists = new UserLists();
            _data[userId] = lists;
        }

        return lists;
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath))
            {
                return;
            }

            var json = File.ReadAllText(_filePath);
            var parsed = JsonSerializer.Deserialize<Dictionary<Guid, UserLists>>(json, SerializerOptions);
            if (parsed is not null)
            {
                _data = parsed;
            }
        }
        catch (Exception ex)
        {
            // A corrupt file must not stop the server from starting; start empty.
            _logger.LogError(ex, "WatchNext: could not read {Path}, starting with empty lists", _filePath);
            _data = new Dictionary<Guid, UserLists>();
        }
    }

    private void Save()
    {
        try
        {
            // Write to a temporary file and move it into place so an interrupted
            // write cannot leave a half-written list behind.
            var tempPath = _filePath + ".tmp";
            File.WriteAllText(tempPath, JsonSerializer.Serialize(_data, SerializerOptions));
            File.Move(tempPath, _filePath, true);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "WatchNext: could not write {Path}", _filePath);
        }
    }
}
