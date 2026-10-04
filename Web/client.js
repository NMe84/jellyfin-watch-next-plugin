/*
 * Watch Next - user-facing client.
 *
 * Injected into the web client's index.html by the File Transformation plugin.
 * Two jobs:
 *
 *   1. Add a "Watch Next" entry to the normal navigation, for every user and
 *      without needing admin dashboard access - both to the drawer that narrow
 *      viewports get and to the top bar that desktop and TV get instead.
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
 * Each navigation entry is built by cloning a neighbouring one and relabelling
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

    /**
     * Pulls the server's own explanation out of a failed request so a rejected
     * add can say why. ApiClient rejects with the Response where it can; when
     * it does not, the caller falls back to a generic message.
     */
    function readError(error) {
        if (error && typeof error.text === 'function') {
            return error.text().then(function (text) {
                return (text || '').replace(/^"|"$/g, '');
            }, function () {
                return '';
            });
        }

        return Promise.resolve('');
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /**
     * Builds a link to an item's detail page in whichever routing dialect this
     * web client uses.
     *
     * The dialect is read off the current URL rather than off a navigation link,
     * because more than one navigation can be present at once - Jellyfin's
     * legacy drawer sits in the page even while the modern app is on screen -
     * and they do not agree: the legacy app routes on the hash (#/details), the
     * modern one on the path (/web/details).
     */
    function detailsHref(itemId) {
        var serverId = (api().serverId && api().serverId()) || '';
        var query = 'id=' + encodeURIComponent(itemId)
            + (serverId ? '&serverId=' + encodeURIComponent(serverId) : '');

        if (window.location.hash.indexOf('#/') === 0) {
            return '#/details?' + query;
        }

        // Path routing: strip the current route off to get the app's base, which
        // keeps this correct when the server is hosted under a base path.
        var base = window.location.pathname.replace(/\/[^/]*$/, '');
        return base + '/details?' + query;
    }

    // ------------------------------------------------------------------ style

    function injectStyles() {
        if (document.getElementById('wn-styles')) {
            return;
        }

        var style = document.createElement('style');
        style.id = 'wn-styles';
        style.textContent = [
            // Must come first and win: the rules below give elements a display
            // value, and a class selector outranks the browser's own
            // [hidden]{display:none}. Without this the spinners, which are
            // hidden by that attribute, were permanently on screen.
            '.wn-overlay [hidden]{display:none !important;}',
            // A <dialog>, so the explicit sizing and reset: user-agent styles
            // centre it and cap its size, and a dialog has its own border and
            // padding.
            '.wn-overlay{position:fixed;inset:0;z-index:100000;width:100%;height:100%;',
            'max-width:100%;max-height:100%;margin:0;padding:0;border:0;',
            'background:#101418;color:#f2f2f2;',
            'overflow-y:auto;-webkit-overflow-scrolling:touch;font-size:15px;}',
            '.wn-overlay::backdrop{background:#101418;}',
            '.wn-panel{max-width:1100px;margin:0 auto;padding:0 16px 48px;}',
            '.wn-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;',
            'padding:14px 0;background:#101418;border-bottom:1px solid rgba(255,255,255,.12);}',
            '.wn-header h1{margin:0;font-size:1.3em;font-weight:500;}',
            '.wn-iconbtn{background:none;border:0;color:inherit;cursor:pointer;padding:8px;border-radius:50%;',
            'display:flex;align-items:center;justify-content:center;min-width:40px;min-height:40px;}',
            '.wn-iconbtn:hover{background:rgba(255,255,255,.12);}',
            '.wn-add{position:relative;margin:16px 0 8px;}',
            // Room on the right for the spinner so typed text never runs under it.
            '.wn-search{width:100%;box-sizing:border-box;padding:12px 42px 12px 14px;font-size:1em;',
            'color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);',
            'border-radius:6px;}',
            '.wn-search:focus{outline:none;border-color:#00a4dc;}',
            '.wn-spin{display:inline-block;flex:0 0 auto;width:18px;height:18px;border-radius:50%;',
            'border:2px solid rgba(255,255,255,.25);border-top-color:#00a4dc;',
            'animation:wn-rotate .7s linear infinite;}',
            '@keyframes wn-rotate{to{transform:rotate(360deg);}}',
            '.wn-add .wn-spin{position:absolute;right:12px;top:50%;margin-top:-9px;}',
            '.wn-loading{display:flex;align-items:center;gap:10px;padding:18px 0;opacity:.7;}',
            '.wn-results{position:absolute;left:0;right:0;top:100%;z-index:3;margin-top:4px;max-height:60vh;',
            'overflow-y:auto;background:#1c2026;border:1px solid rgba(255,255,255,.18);border-radius:6px;',
            'box-shadow:0 8px 24px rgba(0,0,0,.6);}',
            '.wn-result{display:flex;align-items:center;gap:12px;padding:8px 12px;cursor:pointer;',
            'background:none;border:0;width:100%;text-align:left;color:inherit;font:inherit;}',
            '.wn-result:hover,.wn-result:focus{background:rgba(255,255,255,.1);outline:none;}',
            // A match that cannot be added: shown, but visibly inert.
            '.wn-result[disabled]{cursor:default;opacity:.5;}',
            '.wn-result[disabled]:hover{background:none;}',
            '.wn-result-reason{color:#e5a50a;}',
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

    // ------------------------------------------------------------- menu entry

    /*
     * Jellyfin shows its navigation in one of two places, and which one is in
     * the DOM depends on the viewport: below the `md` breakpoint the React web
     * client renders the sliding drawer, and from `md` up it renders none of it
     * and puts the user views in the top toolbar instead. Desktop and TV are
     * therefore toolbar-only - an entry added to the drawer alone is invisible
     * there - so both places are handled, each tracked separately because a
     * resize can swap which one exists.
     *
     * Each entry is a clone of a neighbouring one: in the drawer, of Home; in
     * the toolbar, of Favourites. Cloning means the copy already carries
     * whatever classes and structure that web client version uses, for both the
     * classic and React apps, instead of us hard-coding markup that would rot.
     */
    var TARGETS = [
        {
            name: 'drawer',
            // The modern app's sliding drawer.
            selectors: [
                '.MuiDrawer-root a[href$="/home"]',
                '.MuiDrawer-root a[href="/home"]',
                '.MuiDrawer-root a[href="#/home"]',
                '.MuiDrawer-root a[href*="home.html"]'
            ],
            // Sits between Home and Favourites.
            before: false
        },
        {
            name: 'toolbar',
            // Favourites is the first user-view button in the top bar. Scoped
            // to the header so this never picks up the drawer's own Favourites.
            selectors: [
                'header a[href$="/home?tab=1"]',
                '.MuiToolbar-root a[href$="/home?tab=1"]',
                'header a[href$="home.html?tab=1"]'
            ],
            // Goes to the left of Favourites, matching the drawer's order.
            before: true
        },
        {
            name: 'legacy',
            // Jellyfin's legacy app, which the TV layout runs at any width and
            // which the Desktop/Mobile (legacy) layouts run too. Its drawer is
            // built into the page even while the modern app is the one on
            // screen, so it is a target of its own rather than a fallback -
            // otherwise it would shadow the modern drawer above. Jellyfin 12
            // links to "#/home"; older versions used "#/home.html".
            selectors: [
                '.mainDrawer a[href="#/home"]',
                '.mainDrawer a[href*="home.html"]',
                '.navMenuOptions a[href="#/home"]',
                '.navMenuOptions a[href*="home.html"]'
            ],
            before: false
        }
    ];

    function findReference(target) {
        for (var i = 0; i < target.selectors.length; i++) {
            var found = document.querySelector(target.selectors[i]);
            if (found && !found.closest('.' + MENU_CLASS)) {
                return found;
            }
        }

        return null;
    }

    /**
     * Replaces a cloned entry's label. List items keep their text in a dedicated
     * element; a toolbar button keeps it as a bare text node between the icon
     * and the ripple, so setting textContent there would wipe both.
     */
    function setLabel(link, text) {
        var labelEl = link.querySelector('.navMenuOptionText, .MuiListItemText-primary');
        if (labelEl) {
            labelEl.textContent = text;
            return;
        }

        var done = false;
        Array.prototype.slice.call(link.childNodes).forEach(function (node) {
            if (node.nodeType !== 3 || !node.nodeValue.trim()) {
                return;
            }
            node.nodeValue = done ? '' : text;
            done = true;
        });

        if (!done) {
            link.appendChild(document.createTextNode(text));
        }
    }

    function setIcon(link) {
        var host = link.querySelector('.MuiListItemIcon-root, .MuiButton-startIcon, .material-icons');
        if (host) {
            host.textContent = '';
            host.innerHTML = ICON_SVG;
            return;
        }

        var svg = link.querySelector('svg');
        if (svg) {
            svg.outerHTML = ICON_SVG;
        }
    }

    function insertMenuItem(target) {
        if (!settings.showMenuItem) {
            return;
        }

        var existing = document.querySelector('.' + MENU_CLASS + '[data-wn-target="' + target.name + '"]');
        if (existing && existing.isConnected) {
            return;
        }

        var reference = findReference(target);
        if (!reference) {
            return;
        }

        var container = reference.closest('li') || reference;
        var clone = container.cloneNode(true);
        clone.classList.add(MENU_CLASS);
        clone.setAttribute('data-wn-target', target.name);

        var link = clone.tagName === 'A' ? clone : clone.querySelector('a');
        if (!link) {
            return;
        }

        link.setAttribute('href', '#');
        link.removeAttribute('data-itemid');
        link.removeAttribute('aria-current');
        link.classList.remove('navMenuOptionSelected', 'Mui-selected');
        // The reference may be the active entry, which MUI colours differently.
        link.className = link.className.replace(/Primary\b/g, 'Inherit');

        setLabel(link, settings.menuLabel);
        setIcon(link);

        link.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            closeDrawer();
            open();
        });

        if (target.before) {
            container.parentNode.insertBefore(clone, container);
        } else {
            container.parentNode.insertBefore(clone, container.nextSibling);
        }
    }

    function insertMenuItems() {
        TARGETS.forEach(insertMenuItem);
    }

    /**
     * Dismisses the navigation the entry was tapped in, as a tap outside would.
     *
     * The drawer's OWN backdrop has to be targeted. The page holds several MUI
     * modals at once (menus and popovers, kept mounted and hidden), so a plain
     * '.MuiBackdrop-root' lookup usually returns a hidden popover's backdrop
     * instead, clicks nothing, and leaves the drawer open - with its focus trap
     * still running.
     */
    function closeDrawer() {
        var backdrop = document.querySelector('.MuiDrawer-root .MuiBackdrop-root')
            || document.querySelector('.drawer-backdrop, .backdrop');

        if (backdrop) {
            backdrop.click();
        }
    }

    /**
     * The React web client re-renders the drawer and the toolbar as you navigate
     * and resize, which drops our clones, so keep an eye on the DOM and put them
     * back. insertMenuItem() returns immediately when its entry is already
     * there, so the observer cannot trigger itself in a loop.
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
                insertMenuItems();
            }, 150);
        });

        observer.observe(document.body, { childList: true, subtree: true });
        // A resize can swap the drawer for the toolbar without touching the DOM
        // in a way the observer would see fire usefully.
        window.addEventListener("resize", insertMenuItems);
        insertMenuItems();
    }

    // ----------------------------------------------------------------- overlay

    function open() {
        if (overlay) {
            return;
        }

        injectStyles();

        overlay = document.createElement('dialog');
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
            '    <span class="wn-spin wn-searching" hidden aria-hidden="true"></span>',
            '    <div class="wn-results" hidden></div>',
            '  </div>',
            '  <div class="wn-loading" hidden>',
            '    <span class="wn-spin" aria-hidden="true"></span><span>Loading your list…</span>',
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

        /*
         * Opened as a modal <dialog> so the browser puts it in the top layer and
         * makes everything outside it inert.
         *
         * That is what keeps the search box usable. Jellyfin's drawer is a MUI
         * modal with a focus trap, and on a phone the drawer is exactly how this
         * page gets opened. Its trap reacts to focus landing outside itself by
         * calling focus() on its own panel, so tapping into a plain overlay
         * handed focus straight back to the drawer and nothing could be typed.
         * Against an inert drawer that focus() call does nothing.
         */
        if (typeof overlay.showModal === 'function') {
            overlay.showModal();
            overlay.addEventListener('cancel', function (event) {
                // Escape would close the dialog behind our back, stranding the
                // history entry that open() pushed; close it ourselves instead.
                event.preventDefault();
                close();
            });
        } else {
            overlay.open = true;
        }

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

        // Leave the top layer before detaching, so the page outside stops being
        // inert even if something still holds a reference to the element.
        if (overlay.open && typeof overlay.close === 'function') {
            overlay.close();
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

    /** Shows or hides one of the spinners. */
    function busy(selector, on) {
        if (!overlay) {
            return;
        }

        var el = overlay.querySelector(selector);
        if (el) {
            el.hidden = !on;
        }
    }

    function load() {
        busy('.wn-loading', true);

        apiGet('WatchNext/List').then(function (data) {
            busy('.wn-loading', false);
            renderList('Movie', data.movies || []);
            renderList('Series', data.series || []);
            showMessage('');
        }, function () {
            busy('.wn-loading', false);
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

            // Following a detail link leaves this page. Tear the overlay down
            // and *replace* our pushed history entry with the destination, so
            // going back from the detail page lands where the user opened the
            // list from rather than bouncing through a stale overlay entry.
            var name = event.target.closest('.wn-name');
            if (name) {
                event.preventDefault();
                var href = name.getAttribute('href');
                destroyOverlay();
                window.location.replace(href);
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
                busy('.wn-searching', false);
                results.hidden = true;
                results.innerHTML = '';
                return;
            }

            // Show the spinner now rather than when the request goes out: the
            // debounce below is itself part of the wait, and in a big library
            // silence here reads as nothing happening.
            busy('.wn-searching', true);

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
            }, function (error) {
                readError(error).then(function (text) {
                    showMessage(text || 'Could not add that item.');
                });
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

    /**
     * Searching goes through the plugin rather than straight to /Items so the
     * server can leave out anything already watched, or already on one of the
     * two lists. Deciding that here would mean a second definition of "watched"
     * that could drift from the one the add endpoint enforces.
     */
    function runSearch(term, results) {
        var sequence = ++searchSequence;

        apiGet('WatchNext/Search?term=' + encodeURIComponent(term) + '&limit=20').then(function (items) {
            // A slower earlier request must not overwrite a newer result set.
            if (sequence !== searchSequence || !overlay) {
                return;
            }

            busy('.wn-searching', false);

            if (!items || items.length === 0) {
                results.innerHTML = '<div class="wn-result" style="cursor:default;opacity:.6">'
                    + 'No match in your library</div>';
                results.hidden = false;
                return;
            }

            results.innerHTML = items.map(function (item) {
                var image = item.hasImage
                    ? imageUrl(item.id, 'Primary', 96)
                    : (item.hasThumb ? imageUrl(item.id, 'Thumb', 96) : '');
                var sub = [item.type === 'Series' ? 'Show' : 'Movie', item.year]
                    .filter(Boolean).join(' · ');

                // A match carrying a reason is one that cannot be added. Show it
                // anyway, greyed out and saying why - dropping it silently made
                // searching for something already watched look broken.
                var blocked = !!item.reason;

                return [
                    '<button type="button" class="wn-result" data-id="' + escapeHtml(item.id) + '"'
                        + (blocked ? ' disabled' : '') + '>',
                    image
                        ? '<img src="' + escapeHtml(image) + '" alt="" loading="lazy">'
                        : '<span style="width:32px;height:48px;display:inline-block"></span>',
                    '<span><span>' + escapeHtml(item.name) + '</span>',
                    '<span class="wn-result-sub" style="display:block">' + escapeHtml(sub),
                    blocked
                        ? ' · <span class="wn-result-reason">' + escapeHtml(item.reason) + '</span>'
                        : '',
                    '</span></span>',
                    '</button>'
                ].join('');
            }).join('');

            results.hidden = false;
        }, function () {
            busy('.wn-searching', false);
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
