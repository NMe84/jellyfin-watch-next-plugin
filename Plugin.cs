using System;
using System.Collections.Generic;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.WatchNext;

/// <summary>
/// Main plugin entry point.
///
/// The user-facing part of this plugin is not a dashboard page: Jellyfin's
/// plugin pages are all rendered inside the admin dashboard, which ordinary
/// users cannot reach.  Instead a small loader script is injected into the web
/// client's index.html (via the File Transformation plugin), which adds a
/// "Watch Next" entry to the normal left-hand drawer for every user.
///
/// The dashboard page below is only a status/settings page for the admin.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>Stable id of this plugin.</summary>
    public const string PluginGuid = "c9e4b7a2-3f6d-4a51-8b2c-1d7e5f9a4c83";

    public static Plugin? Instance { get; private set; }

    public override Guid Id => new Guid(PluginGuid);

    public override string Name => "Watch Next";

    public override string Description =>
        "A personal, drag-and-drop ordered list of the movies and shows each user wants to watch next.";

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = "watchnext",
                EmbeddedResourcePath = $"{GetType().Namespace}.Configuration.configPage.html",
                EnableInMainMenu = true,
                MenuSection = "server",
                MenuIcon = "playlist_play",
                DisplayName = "Watch Next"
            }
        };
    }
}
