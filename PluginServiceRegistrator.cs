using Jellyfin.Plugin.WatchNext.Services;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.WatchNext;

/// <summary>
/// Registers plugin services into Jellyfin's DI container at startup.
/// Jellyfin discovers this class automatically via reflection.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // The store is shared between the API controller and the auto-remove
        // service, so it has to be a singleton.
        serviceCollection.AddSingleton<WatchNextStore>();
        serviceCollection.AddHostedService<WatchNextAutoRemoveService>();
        serviceCollection.AddHostedService<WebInjectionService>();
    }
}
