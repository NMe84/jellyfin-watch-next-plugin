using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.WatchNext;

/// <summary>
/// Admin-level settings.  The lists themselves are per-user and are stored
/// separately (see <see cref="Services.WatchNextStore"/>), not in here.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Label used for the entry added to the web client's navigation drawer.
    /// </summary>
    public string MenuLabel { get; set; } = "Watch Next";

    /// <summary>
    /// Whether the navigation drawer entry (and with it the user-facing page)
    /// is injected into the web client at all.
    /// </summary>
    public bool ShowMenuItem { get; set; } = true;
}
