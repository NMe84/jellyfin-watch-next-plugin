using System;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.WatchNext.Services;

/// <summary>
/// Registers our index.html rewrite with the File Transformation plugin.
///
/// File Transformation is a required companion plugin that the user installs
/// separately (Jellyfin manifests have no dependency mechanism). It is a
/// separate plugin assembly that Jellyfin may well load after this one, and
/// there is no compile-time package for it. So the whole bridge is reflection:
/// find the plugin's assembly in any load context, call its static
/// PluginInterface.RegisterTransformation, and retry for a while if it is not
/// there yet.
///
/// The payload object is built through *their* Newtonsoft type rather than one
/// of ours, deliberately. Each plugin can end up with its own copy of
/// Newtonsoft.Json, and a JObject from a different load context would not be
/// assignable to their parameter. Taking the type straight off their method
/// signature sidesteps that entirely, and means we need no JSON dependency.
/// </summary>
public sealed class WebInjectionService : IHostedService
{
    private const string FileTransformationAssembly = "Jellyfin.Plugin.FileTransformation";
    private const string PluginInterfaceType = "Jellyfin.Plugin.FileTransformation.PluginInterface";

    /// <summary>Stable id for our registration, so we can withdraw it again.</summary>
    private static readonly Guid TransformationId = new Guid("b1f0d3e5-6a74-4c29-9d81-3fa7c26e5b90");

    private static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(5);
    private const int MaxAttempts = 24; // roughly two minutes

    private readonly ILogger<WebInjectionService> _logger;
    private readonly CancellationTokenSource _stopping = new CancellationTokenSource();

    private bool _registered;

    public WebInjectionService(ILogger<WebInjectionService> logger)
    {
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Fire and forget: startup must not block on another plugin appearing.
        _ = Task.Run(() => RegisterWhenAvailableAsync(_stopping.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _stopping.Cancel();

        if (_registered)
        {
            try
            {
                var pluginInterface = FindPluginInterface();
                pluginInterface
                    ?.GetMethod("RemoveTransformation", BindingFlags.Public | BindingFlags.Static)
                    ?.Invoke(null, new object[] { TransformationId });
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "WatchNext: could not withdraw the web client transformation");
            }
        }

        return Task.CompletedTask;
    }

    private async Task RegisterWhenAvailableAsync(CancellationToken cancellationToken)
    {
        for (var attempt = 1; attempt <= MaxAttempts && !cancellationToken.IsCancellationRequested; attempt++)
        {
            try
            {
                if (TryRegister())
                {
                    _registered = true;
                    _logger.LogInformation("WatchNext: registered the web client transformation");
                    return;
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "WatchNext: error while registering the web client transformation");
                return;
            }

            try
            {
                await Task.Delay(RetryInterval, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }

        if (!cancellationToken.IsCancellationRequested)
        {
            _logger.LogError(
                "WatchNext: the File Transformation plugin was not found, so the Watch Next menu entry cannot be "
                + "added. Install it from https://www.iamparadox.dev/jellyfin/plugins/manifest.json and "
                + "restart Jellyfin.");
        }
    }

    private bool TryRegister()
    {
        var pluginInterface = FindPluginInterface();
        if (pluginInterface is null)
        {
            return false;
        }

        var register = pluginInterface.GetMethod("RegisterTransformation", BindingFlags.Public | BindingFlags.Static)
            ?? throw new MissingMethodException(PluginInterfaceType, "RegisterTransformation");

        var payloadType = register.GetParameters()[0].ParameterType;
        var parse = payloadType.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, new[] { typeof(string) })
            ?? throw new MissingMethodException(payloadType.FullName, "Parse");

        var json = string.Format(
            CultureInfo.InvariantCulture,
            "{{\"id\":\"{0}\",\"fileNamePattern\":\"index.html\",\"callbackAssembly\":\"{1}\","
            + "\"callbackClass\":\"{2}\",\"callbackMethod\":\"{3}\"}}",
            TransformationId,
            typeof(WebTransformation).Assembly.FullName,
            typeof(WebTransformation).FullName,
            nameof(WebTransformation.Transform));

        var payload = parse.Invoke(null, new object[] { json });
        register.Invoke(null, new[] { payload });
        return true;
    }

    private static Type? FindPluginInterface()
    {
        foreach (var context in AssemblyLoadContext.All)
        {
            Assembly[] assemblies;
            try
            {
                assemblies = context.Assemblies.ToArray();
            }
            catch (InvalidOperationException)
            {
                // The collection can change while another plugin is still loading.
                continue;
            }

            foreach (var assembly in assemblies)
            {
                if (!string.Equals(
                        assembly.GetName().Name,
                        FileTransformationAssembly,
                        StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var type = assembly.GetType(PluginInterfaceType);
                if (type is not null)
                {
                    return type;
                }
            }
        }

        return null;
    }
}
