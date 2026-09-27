using System;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.WatchNext.Services;

/// <summary>
/// Takes items off a user's list once they have actually been watched.
///
/// Either route counts: finishing playback, or ticking the checkmark by hand.
/// For a show, ANY episode becoming watched removes the whole series - the list
/// answers "what do I start next", so once you have started it, it is no longer
/// next.
///
/// Un-watching never re-adds anything, and a playback-driven "unwatched" (which
/// Jellyfin fires when you abandon a rewatch part-way) is ignored outright.
/// </summary>
public sealed class WatchNextAutoRemoveService : IHostedService
{
    private readonly IUserDataManager _userDataManager;
    private readonly WatchNextStore _store;
    private readonly ILogger<WatchNextAutoRemoveService> _logger;

    public WatchNextAutoRemoveService(
        IUserDataManager userDataManager,
        WatchNextStore store,
        ILogger<WatchNextAutoRemoveService> logger)
    {
        _userDataManager = userDataManager;
        _store = store;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _userDataManager.UserDataSaved += OnUserDataSaved;
        _logger.LogInformation("WatchNext: watching for finished playback");
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _userDataManager.UserDataSaved -= OnUserDataSaved;
        return Task.CompletedTask;
    }

    private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
    {
        try
        {
            if (e.SaveReason != UserDataSaveReason.PlaybackFinished &&
                e.SaveReason != UserDataSaveReason.TogglePlayed)
            {
                return;
            }

            // Only a transition *into* watched removes anything.
            if (e.UserData is null || !e.UserData.Played)
            {
                return;
            }

            // An episode, season or series all point back at the series entry;
            // a movie removes itself.
            var targetId = e.Item switch
            {
                Movie movie => movie.Id,
                Episode episode => episode.SeriesId,
                Season season => season.SeriesId,
                Series series => series.Id,
                _ => Guid.Empty
            };

            if (targetId == Guid.Empty)
            {
                return;
            }

            if (_store.Remove(e.UserId, targetId))
            {
                _logger.LogInformation(
                    "WatchNext: removed {ItemId} from the list of user {UserId} after {Reason}",
                    targetId,
                    e.UserId,
                    e.SaveReason);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "WatchNext: failed to process a watch-state change");
        }
    }
}
