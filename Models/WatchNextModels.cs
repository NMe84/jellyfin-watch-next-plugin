using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.WatchNext.Models;

/// <summary>
/// Which of the two lists an entry belongs to.  Movies and shows are kept
/// apart so the UI can render (and order) them independently.
/// </summary>
public enum WatchNextKind
{
    Movie,
    Series
}

/// <summary>
/// One user's two ordered lists.  Order is the order of the lists themselves:
/// index 0 is "watch this next".
/// </summary>
public class UserLists
{
    public List<Guid> Movies { get; set; } = new List<Guid>();

    public List<Guid> Series { get; set; } = new List<Guid>();

    public List<Guid> For(WatchNextKind kind) => kind == WatchNextKind.Movie ? Movies : Series;
}

/// <summary>
/// Body of the reorder request sent by the client after a drag has finished.
/// </summary>
public class ReorderRequest
{
    /// <summary>"Movie" or "Series".</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>The complete list of item ids, in their new order.</summary>
    public List<Guid> Ids { get; set; } = new List<Guid>();
}
