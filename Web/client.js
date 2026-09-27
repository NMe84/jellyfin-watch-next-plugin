/*
 * Watch Next - user-facing client.
 *
 * Injected into the web client's index.html by the File Transformation plugin.
 * Two jobs:
 *
 *   1. Add a "Watch Next" entry to the normal navigation drawer, for every
 *      user, without needing admin dashboard access.
 *   2. Render the page behind it: two independently ordered lists (movies and
 *      shows) with posters, links into the detail pages, and drag-and-drop
 *      reordering that also works with a finger.
 *
 * The page is drawn as a full-screen overlay rather than a route. Jellyfin's
 * router is not a public extension point and its shape differs between the
 * classic and the React web apps; an overlay behaves identically on both and
 * cannot be broken by a web client update. The browser's back button still
 * closes it, because opening pushes a history entry.
 *
 * The drawer entry is built by cloning the existing "Home" entry and relabelling
 * the copy, for the same reason: whatever markup and classes that version of the
 * web client uses, the clone already has them.
 */
(function () {
    'use strict';

    if (window.__watchNextLoaded) {
        return;
    }
    window.__watchNextLoaded = true;

    var MENU_CLASS = 'wn-menu-item';
    var ICON_SVG = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" '
        + 'style="display:block"><path d="M3 6h12v2H3V6zm0 4h12v2H3v-2zm0 4h8v2H3v-2zm13-1v7l6-3.5L16 13z"/></svg>';

    var settings = { menuLabel: 'Watch Next', showMenuItem: true };

    // href of the drawer's Home entry, captured when we clone it. It tells us
    // whether this web client routes on the hash (#/home.html) or on the path
    // (/web/home), so we can build detail links in the same dialect.
    var homeHref = null;

    var overlay = null;
    var searchTimer = null;
    var dismissResults = null;
    var searchSequence = 0;

    // ---------------------------------------------------------------- helpers

    function api() {
        return window.ApiClient;
    }

    function apiGet(path) {
        return api().getJSON(api().getUrl(path));
    }

    function apiSend(method, path, body) {
        return api().ajax({
            type: method,
            url: api().getUrl(path),
            data: body ? JSON.stringify(body) : null,
            contentType: 'application/json'
        });
    }

    function imageUrl(itemId, type, height) {
        return api().getUrl('Items/' + itemId + '/Images/' + type, {
            maxHeight: height,
            quality: 90
        });
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /**
     * Builds a link to an item's detail page in whichever routing dialect this
     * web client uses. Falls back to the hash form, which every Jellyfin web
     * client has understood so far.
     */
    function detailsHref(itemId) {
        var serverId = (api().serverId && api().serverId()) || '';
        var query = 'id=' + encodeURIComponent(itemId) + (serverId ? '&serverId=' + encodeURIComponent(serverId) : '');

        if (!homeHref || homeHref.charAt(0) === '#') {
            return '#/details?' + query;
        }

        return homeHref.replace(/\/home(\.html)?(\?.*)?$/, '/details') + '?' + query;
    }

    // ------------------------------------------------------------------ style

    function injectStyles() {
        if (document.getElementById('wn-styles')) {
            return;
        }

        var style = document.createElement('style');
        style.id = 'wn-styles';
        style.textContent = [
            '.wn-overlay{position:fixed;inset:0;z-index:100000;background:#101418;color:#f2f2f2;',
            'overflow-y:auto;-webkit-overflow-scrolling:touch;font-size:15px;}',
            '.wn-panel{max-width:1100px;margin:0 auto;padding:0 16px 48px;}',
            '.wn-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;',
            'padding:14px 0;background:#101418;border-bottom:1px solid rgba(255,255,255,.12);}',
            '.wn-header h1{margin:0;font-size:1.3em;font-weight:500;}',
            '.wn-iconbtn{background:none;border:0;color:inherit;cursor:pointer;padding:8px;border-radius:50%;',
            'display:flex;align-items:center;justify-content:center;min-width:40px;min-height:40px;}',
            '.wn-iconbtn:hover{background:rgba(255,255,255,.12);}',
            '.wn-add{position:relative;margin:16px 0 8px;}',
            '.wn-search{width:100%;box-sizing:border-box;padding:12px 14px;font-size:1em;color:inherit;',
            'background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);border-radius:6px;}',
            '.wn-search:focus{outline:none;border-color:#00a4dc;}',
            '.wn-results{position:absolute;left:0;right:0;top:100%;z-index:3;margin-top:4px;max-height:60vh;',
            'overflow-y:auto;background:#1c2026;border:1px solid rgba(255,255,255,.18);border-radius:6px;',
            'box-shadow:0 8px 24px rgba(0,0,0,.6);}',
            '.wn-result{display:flex;align-items:center;gap:12px;padding:8px 12px;cursor:pointer;',
            'background:none;border:0;width:100%;text-align:left;color:inherit;font:inherit;}',
            '.wn-result:hover,.wn-result:focus{background:rgba(255,255,255,.1);outline:none;}',
            '.wn-result img{width:32px;height:48px;object-fit:cover;border-radius:3px;background:rgba(255,255,255,.1);}',
            '.wn-result-sub{opacity:.6;font-size:.85em;}',
            '.wn-columns{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:24px;}',
            '.wn-col h2{margin:0 0 8px;font-size:1.05em;font-weight:500;text-transform:uppercase;',
            'letter-spacing:.06em;opacity:.7;}',
            '.wn-list{list-style:none;margin:0;padding:0;}',
            '.wn-row{display:flex;align-items:center;gap:12px;padding:8px;margin-bottom:8px;border-radius:6px;',
            'background:rgba(255,255,255,.06);touch-action:pan-y;}',
            '.wn-row.wn-dragging{background:rgba(0,164,220,.25);box-shadow:0 6px 18px rgba(0,0,0,.5);',
            'position:relative;z-index:5;}',
            '.wn-handle{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:36px;',
            'height:44px;cursor:grab;opacity:.55;touch-action:none;user-select:none;-webkit-user-select:none;}',
            '.wn-handle:active{cursor:grabbing;}',
            '.wn-poster{flex:0 0 auto;width:40px;height:60px;object-fit:cover;border-radius:3px;',
            'background:rgba(255,255,255,.1);}',
            '.wn-meta{flex:1 1 auto;min-width:0;}',
            '.wn-name{display:block;color:inherit;text-decoration:none;overflow:hidden;text-overflow:ellipsis;',
            'white-space:nowrap;}',
            '.wn-name:hover{text-decoration:underline;}',
            '.wn-year{display:block;opacity:.55;font-size:.85em;}',
            '.wn-empty{opacity:.5;font-style:italic;margin:4px 0 0;}',
            '.wn-message{padding:16px 0;opacity:.7;}',
            '@media (max-width:700px){.wn-columns{grid-template-columns:1fr;gap:20px;}}'
        ].join('');
        document.head.appendChild(style);
    }

    // ------------------------------------------------------------- drawer item

    /**
     * Finds the drawer's Home entry. The classic web client renders it as an
     * <a class="navMenuOption" href="#/home.html">, the React one as a MUI list
     * item linking to /web/home.
     */
    function findHomeLink() {
        var selectors = [
            '.mainDrawer a[href*="home.html"]',
            '.navMenuOptions a[href*="home.html"]',
            '.MuiDrawer-root a[href$="/home"]',
            '.MuiDrawer-root a[href="/home"]',
            '.MuiDrawer-root a[href*="home.html"]'
        ];

        for (var i = 0; i < selectors.length; i++) {
            var found = document.querySelector(selectors[i]);
            if (found) {
                return found;
            }
        }

        return null;
    }

    function insertMenuItem() {
        if (!settings.showMenuItem || document.querySelector('.' + MENU_CLASS)) {
            return;
        }

        var home = findHomeLink();
        if (!home) {
            return;
        }

        homeHref = home.getAttribute('href');

        var container = home.closest('li') || home;
        var clone = container.cloneNode(true);
        clone.classList.add(MENU_CLASS);

        var link = clone.tagName === 'A' ? clone : clone.querySelector('a');
        if (!link) {
            return;
        }

        link.setAttribute('href', '#');
        link.removeAttribute('data-itemid');
        link.removeAttribute('aria-current');
        link.classList.remove('navMenuOptionSelected', 'Mui-selected');

        var label = link.querySelector('.navMenuOptionText, .MuiListItemText-primary');
        if (label) {
            label.textContent = settings.menuLabel;
        } else {
            link.textContent = settings.menuLabel;
        }

        var icon = link.querySelector('.MuiListItemIcon-root, .material-icons, svg');
        if (icon) {
            if (icon.tagName.toLowerCase() === 'svg') {
                icon.outerHTML = ICON_SVG;
            } else {
                icon.textContent = '';
                icon.innerHTML = ICON_SVG;
            }
        }

        link.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            closeDrawer();
            open();
        });

        container.parentNode.insertBefore(clone, container.nextSibling);
    }

    /** Dismisses the drawer by clicking its backdrop, as a tap outside would. */
    function closeDrawer() {
        var backdrop = document.querySelector('.MuiBackdrop-root, .drawer-backdrop, .backdrop');
        if (backdrop) {
            backdrop.click();
        }
    }

    /**
     * The React web client re-renders the drawer whenever it opens, which drops
     * our clone, so keep an eye on the DOM and put it back. insertMenuItem()
     * returns immediately when the entry is already there, so the observer
     * cannot trigger itself in a loop.
     */
    function watchForDrawer() {
        var pending = false;

        var observer = new MutationObserver(function () {
            if (pending) {
                return;
            }
            pending = true;
            window.setTimeout(function () {
                pending = false;
                insertMenuItem();
            }, 150);
        });

        observer.observe(document.body, { childList: true, subtree: true });
        insertMenuItem();
    }

    // ----------------------------------------------------------------- overlay

    function open() {
        if (overlay) {
            return;
        }

        injectStyles();

        overlay = document.createElement('div');
        overlay.className = 'wn-overlay';
        overlay.innerHTML = [
            '<div class="wn-panel">',
            '  <div class="wn-header">',
            '    <button class="wn-iconbtn wn-close" aria-label="Close">',
            '      <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">',
            '        <path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20v-2z"/></svg>',
            '    </button>',
            '    <h1></h1>',
            '  </div>',
            '  <div class="wn-add">',
            '    <input class="wn-search" type="search" autocomplete="off" spellcheck="false"',
            '           placeholder="Search for a movie or show to add…">',
            '    <div class="wn-results" hidden></div>',
            '  </div>',
            '  <div class="wn-columns">',
            '    <section class="wn-col"><h2>Movies</h2>',
            '      <ul class="wn-list" data-kind="Movie"></ul>',
            '      <p class="wn-empty" data-kind="Movie" hidden>Nothing lined up yet.</p>',
            '    </section>',
            '    <section class="wn-col"><h2>Shows</h2>',
            '      <ul class="wn-list" data-kind="Series"></ul>',
            '      <p class="wn-empty" data-kind="Series" hidden>Nothing lined up yet.</p>',
            '    </section>',
            '  </div>',
            '  <p class="wn-message" hidden></p>',
            '</div>'
        ].join('\n');

        overlay.querySelector('h1').textContent = settings.menuLabel;
        overlay.querySelector('.wn-close').addEventListener('click', close);

        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';

        bindSearch();
        bindListActions();

        overlay.querySelectorAll('.wn-list').forEach(function (list) {
            makeSortable(list);
        });

        window.addEventListener('popstate', onPopState);
        history.pushState({ watchNext: true }, '');

        load();
    }

    function onPopState() {
        destroyOverlay();
    }

    function close() {
        if (history.state && history.state.watchNext) {
            // Unwinds our own history entry; popstate then tears the overlay down.
            history.back();
        } else {
            destroyOverlay();
        }
    }

    function destroyOverlay() {
        if (!overlay) {
            return;
        }

        window.removeEventListener("popstate", onPopState);

        if (dismissResults) {
            document.removeEventListener("click", dismissResults);
            dismissResults = null;
        }

        overlay.remove();
        overlay = null;
        document.body.style.overflow = '';
    }

    function showMessage(text) {
        if (!overlay) {
            return;
        }
        var el = overlay.querySelector('.wn-message');
        el.textContent = text || '';
        el.hidden = !text;
    }

    // -------------------------------------------------------------------- data

    function load() {
        apiGet('WatchNext/List').then(function (data) {
            renderList('Movie', data.movies || []);
            renderList('Series', data.series || []);
            showMessage('');
        }, function () {
            showMessage('Could not load your list. Please try again.');
        });
    }

    function renderList(kind, items) {
        if (!overlay) {
            return;
        }

        var list = overlay.querySelector('.wn-list[data-kind="' + kind + '"]');
        var empty = overlay.querySelector('.wn-empty[data-kind="' + kind + '"]');

        list.innerHTML = items.map(function (item) {
            var image = item.hasImage
                ? imageUrl(item.id, 'Primary', 120)
                : (item.hasThumb ? imageUrl(item.id, 'Thumb', 120) : '');

            return [
                '<li class="wn-row" data-id="' + escapeHtml(item.id) + '">',
                '  <span class="wn-handle" role="button" aria-label="Drag to reorder">',
                '    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">',
                '      <path d="M4 7h16v2H4V7zm0 4h16v2H4v-2zm0 4h16v2H4v-2z"/></svg>',
                '  </span>',
                image
                    ? '  <img class="wn-poster" src="' + escapeHtml(image) + '" alt="" loading="lazy">'
                    : '  <span class="wn-poster"></span>',
                '  <span class="wn-meta">',
                '    <a class="wn-name" href="' + escapeHtml(detailsHref(item.id)) + '">'
                    + escapeHtml(item.name) + '</a>',
                item.year ? '    <span class="wn-year">' + escapeHtml(item.year) + '</span>' : '',
                '  </span>',
                '  <button class="wn-iconbtn wn-remove" aria-label="Remove from list">',
                '    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">',
                '      <path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19'
                    + ' 17.6 13.4 12z"/></svg>',
                '  </button>',
                '</li>'
            ].join('\n');
        }).join('');

        empty.hidden = items.length > 0;
    }

    function bindListActions() {
        overlay.addEventListener('click', function (event) {
            var remove = event.target.closest('.wn-remove');
            if (remove) {
                var row = remove.closest('.wn-row');
                apiSend('DELETE', 'WatchNext/Items/' + row.dataset.id).then(load, function () {
                    showMessage('Could not remove that item.');
                });
                return;
            }

            // Following a detail link leaves this page, so drop the overlay -
            // and with it our history entry - before the router takes over.
            var name = event.target.closest('.wn-name');
            if (name) {
                event.preventDefault();
                var href = name.getAttribute('href');
                close();
                window.location.href = href;
            }
        });
    }

    // ------------------------------------------------------------------ search

    function bindSearch() {
        var input = overlay.querySelector('.wn-search');
        var results = overlay.querySelector('.wn-results');

        input.addEventListener('input', function () {
            window.clearTimeout(searchTimer);
            var term = input.value.trim();

            if (term.length < 2) {
                results.hidden = true;
                results.innerHTML = '';
                return;
            }

            searchTimer = window.setTimeout(function () {
                runSearch(term, results);
            }, 300);
        });

        results.addEventListener('click', function (event) {
            var button = event.target.closest('.wn-result');
            if (!button) {
                return;
            }

            apiSend('POST', 'WatchNext/Items/' + button.dataset.id).then(function () {
                input.value = '';
                results.hidden = true;
                results.innerHTML = '';
                load();
            }, function () {
                showMessage('Could not add that item.');
            });
        });

        // Dismiss the suggestion list on a tap anywhere else. Tracked so it can
        // be taken off again when the overlay goes away, rather than piling up
        // one stale listener per visit.
        dismissResults = function (event) {
            if (overlay && !event.target.closest('.wn-add')) {
                results.hidden = true;
            }
        };
        document.addEventListener('click', dismissResults);
    }

    function runSearch(term, results) {
        var sequence = ++searchSequence;

        var url = api().getUrl('Items', {
            userId: api().getCurrentUserId(),
            searchTerm: term,
            includeItemTypes: 'Movie,Series',
            recursive: true,
            limit: 20,
            enableTotalRecordCount: false
        });

        api().getJSON(url).then(function (data) {
            // A slower earlier request must not overwrite a newer result set.
            if (sequence !== searchSequence || !overlay) {
                return;
            }

            var items = data.Items || [];
            if (items.length === 0) {
                results.innerHTML = '<div class="wn-result" style="cursor:default;opacity:.6">No matches</div>';
                results.hidden = false;
                return;
            }

            results.innerHTML = items.map(function (item) {
                var tag = item.ImageTags && item.ImageTags.Primary;
                var image = tag
                    ? api().getUrl('Items/' + item.Id + '/Images/Primary', { maxHeight: 96, tag: tag })
                    : '';
                var sub = [item.Type === 'Series' ? 'Show' : 'Movie', item.ProductionYear]
                    .filter(Boolean).join(' · ');

                return [
                    '<button type="button" class="wn-result" data-id="' + escapeHtml(item.Id) + '">',
                    image
                        ? '<img src="' + escapeHtml(image) + '" alt="" loading="lazy">'
                        : '<span style="width:32px;height:48px;display:inline-block"></span>',
                    '<span><span>' + escapeHtml(item.Name) + '</span>',
                    '<span class="wn-result-sub" style="display:block">' + escapeHtml(sub) + '</span></span>',
                    '</button>'
                ].join('');
            }).join('');

            results.hidden = false;
        }, function () {
            showMessage('Search failed.');
        });
    }

    // ------------------------------------------------------- drag and drop

    /**
     * Reordering by pointer events rather than HTML5 drag-and-drop, because
     * the HTML5 API never fires on touch devices.
     *
     * Dragging starts only from the handle, which is marked touch-action:none
     * so the gesture is ours; everywhere else on the row the list still scrolls
     * normally. Rows are moved in the DOM as soon as the pointer passes a
     * neighbour's midpoint, and the dragged row is re-anchored under the finger
     * after each move, so what you see is always the order that will be saved.
     */
    function makeSortable(list) {
        var row = null;
        var pointerId = null;
        var anchorY = 0;
        var originY = 0;
        var scroller = null;
        var autoScrollFrame = null;
        var lastClientY = 0;

        list.addEventListener('pointerdown', function (event) {
            var handle = event.target.closest('.wn-handle');
            if (!handle || !list.contains(handle) || event.button > 0) {
                return;
            }

            row = handle.closest('.wn-row');
            if (!row) {
                return;
            }

            event.preventDefault();
            pointerId = event.pointerId;
            handle.setPointerCapture(pointerId);

            anchorY = event.clientY;
            originY = row.getBoundingClientRect().top;
            lastClientY = event.clientY;
            scroller = overlay;
            row.classList.add('wn-dragging');

            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);

            startAutoScroll();
        });

        function onMove(event) {
            if (!row) {
                return;
            }

            event.preventDefault();
            lastClientY = event.clientY;
            row.style.transform = 'translateY(' + (event.clientY - anchorY) + 'px)';
            reposition();
        }

        function reposition() {
            var centre = originY + (lastClientY - anchorY) + row.offsetHeight / 2;
            var siblings = Array.prototype.filter.call(list.children, function (child) {
                return child !== row;
            });

            for (var i = 0; i < siblings.length; i++) {
                var box = siblings[i].getBoundingClientRect();
                if (centre < box.top + box.height / 2) {
                    if (siblings[i].previousElementSibling !== row) {
                        list.insertBefore(row, siblings[i]);
                        reanchor();
                    }
                    return;
                }
            }

            if (list.lastElementChild !== row) {
                list.appendChild(row);
                reanchor();
            }
        }

        /**
         * After the row has been moved in the DOM its natural position changed,
         * so clear the offset and measure again: the row settles into its new
         * slot and keeps following the pointer from there.
         */
        function reanchor() {
            row.style.transform = '';
            originY = row.getBoundingClientRect().top;
            anchorY = lastClientY;
        }

        function startAutoScroll() {
            if (autoScrollFrame) {
                return;
            }

            var step = function () {
                if (!row || !scroller) {
                    autoScrollFrame = null;
                    return;
                }

                var edge = 72;
                var delta = 0;

                if (lastClientY < edge) {
                    delta = -Math.ceil((edge - lastClientY) / 6);
                } else if (lastClientY > window.innerHeight - edge) {
                    delta = Math.ceil((lastClientY - (window.innerHeight - edge)) / 6);
                }

                if (delta !== 0) {
                    var before = scroller.scrollTop;
                    scroller.scrollTop += delta;
                    // Scrolling moves every row, this one included; compensate
                    // so it stays put under the pointer.
                    originY -= scroller.scrollTop - before;
                    reposition();
                }

                autoScrollFrame = window.requestAnimationFrame(step);
            };

            autoScrollFrame = window.requestAnimationFrame(step);
        }

        function onUp(event) {
            if (!row) {
                return;
            }

            var handle = event.currentTarget;
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);

            if (handle.hasPointerCapture && handle.hasPointerCapture(pointerId)) {
                handle.releasePointerCapture(pointerId);
            }

            if (autoScrollFrame) {
                window.cancelAnimationFrame(autoScrollFrame);
                autoScrollFrame = null;
            }

            row.style.transform = '';
            row.classList.remove('wn-dragging');
            row = null;
            pointerId = null;

            commitOrder(list);
        }
    }

    function commitOrder(list) {
        var ids = Array.prototype.map.call(list.querySelectorAll('.wn-row'), function (row) {
            return row.dataset.id;
        });

        apiSend('POST', 'WatchNext/Order', { Kind: list.dataset.kind, Ids: ids }).catch(function () {
            showMessage('Could not save the new order.');
            load();
        });
    }

    // ------------------------------------------------------------------- start

    apiGet('WatchNext/Config').then(function (config) {
        if (config && config.menuLabel) {
            settings.menuLabel = config.menuLabel;
        }
        if (config && config.showMenuItem === false) {
            settings.showMenuItem = false;
        }
        watchForDrawer();
    }, function () {
        // Fall back to the defaults rather than leaving the user without a link.
        watchForDrawer();
    });
})();
