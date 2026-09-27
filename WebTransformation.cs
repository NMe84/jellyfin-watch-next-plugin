using System;

namespace Jellyfin.Plugin.WatchNext;

/// <summary>
/// Callback invoked by the File Transformation plugin for every request to the
/// web client's index.html.
///
/// File Transformation hands us a JSON object with a single "contents" field
/// and expects the rewritten document back as a string, so this has to be a
/// public static method taking one deserialisable parameter. It is resolved by
/// reflection, which is why the class and method names are registered as
/// strings in <see cref="Services.WebInjectionService"/> - keep them in sync.
/// </summary>
public static class WebTransformation
{
    /// <summary>Marker so a document is never injected into twice.</summary>
    private const string Marker = "watch-next-loader";

    /// <summary>
    /// Shape of the payload File Transformation passes in. Newtonsoft matches
    /// "contents" to this property case-insensitively.
    /// </summary>
    public class TransformationPayload
    {
        public string Contents { get; set; } = string.Empty;
    }

    /// <summary>
    /// Appends a tiny bootstrap script to index.html. The bootstrap waits for
    /// the web client's ApiClient to be signed in and then pulls the real UI
    /// from this plugin, so the injected markup stays a couple of lines and the
    /// actual client code remains a normal, editable .js file.
    ///
    /// Going through ApiClient.getUrl also keeps the URL correct when the
    /// server is hosted under a base path.
    /// </summary>
    public static string Transform(TransformationPayload payload)
    {
        var contents = payload?.Contents;
        if (string.IsNullOrEmpty(contents) || contents.Contains(Marker, StringComparison.Ordinal))
        {
            return contents ?? string.Empty;
        }

        if (Plugin.Instance?.Configuration.ShowMenuItem == false)
        {
            return contents;
        }

        var index = contents.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (index < 0)
        {
            return contents;
        }

        return contents.Insert(index, Bootstrap);
    }

    private const string Bootstrap = @"
<script id=""watch-next-loader"">
(function () {
    function boot() {
        var api = window.ApiClient;
        if (!api || typeof api.getUrl !== 'function' || !api.accessToken || !api.accessToken()) {
            return window.setTimeout(boot, 300);
        }
        if (document.getElementById('watch-next-client')) {
            return;
        }
        var script = document.createElement('script');
        script.id = 'watch-next-client';
        script.src = api.getUrl('WatchNext/client.js');
        script.async = true;
        document.head.appendChild(script);
    }
    boot();
})();
</script>
";
}
