# <img src="https://raw.githubusercontent.com/NMe84/jellyfin-watch-next-plugin/master/watchnext.png" height="32"> Watch Next — a personal queue for Jellyfin

A Jellyfin plugin that gives **every user** their own ordered list of what they want to watch next — one list for movies, one for shows, side by side on a single page. Drag the entries into the order you want; whatever sits at the top is what you watch next. Once you have actually watched something, it takes itself off the list.

The page is reachable from the normal navigation drawer, so **no admin dashboard access is needed** — it is a user feature, not a server setting.

## Features

- **Two lists, one page** — movies and shows are kept apart and ordered independently, so a long show backlog never buries the film you meant to watch tonight.
- **Drag to reorder, on any device** — reordering uses pointer events rather than HTML5 drag-and-drop, which never fires on touch screens. Dragging works the same with a mouse or a finger, including auto-scrolling when you drag past the edge of the screen.
- **Removes itself once watched** — a movie disappears when playback finishes *or* when you tick it off by hand; a show disappears as soon as **any** of its episodes is watched, since by then you have clearly started it. Un-watching something never puts it back.
- **Only offers what you have not seen** — search leaves out anything you have already watched, any show you have already started, and anything already on one of your lists, so the list cannot fill up with things you are done with.
- **Everywhere in the web client** — the entry appears in the navigation drawer on a phone, in the top bar on a desktop, and in the drawer of the TV layout, which runs Jellyfin's legacy app.
- **Per user, private** — each list belongs to the user whose token made the request. The user id comes from the access token's claims, never from a parameter, so one user cannot see or edit another's list.
- **Mobile-friendly** — the two lists sit side by side on a desktop and stack into one column on a phone.
- **Poster and a link** — each row shows the poster (falling back to the thumbnail) and the title, which links straight to the item's detail page.
- **Survives plugin updates** — the lists are stored in the server's data directory, not in the plugin's version-stamped folder, so updating the plugin does not wipe them.

## Requirements

- Jellyfin **12.0 or newer**. Jellyfin 12 moved to .NET 10; this plugin is built for `net10.0` and cannot load on 10.x.
- The **File Transformation** plugin by [IAmParadox27](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation). This is what lets Watch Next add its entry to the web client's navigation drawer.

  Jellyfin's plugin catalogue has no notion of dependencies, so it has to be installed separately — see below.

## Installation

1. Add the **File Transformation** repository:
   **Dashboard → Plugins → Repositories → +**
   URL: `https://www.iamparadox.dev/jellyfin/plugins/manifest.json`
   Then install **File Transformation** from the catalogue.
2. Add this repository the same way:
   URL: `https://raw.githubusercontent.com/NMe84/jellyfin-plugins/gh-pages/manifest.json`
   Then install **Watch Next**.
3. Restart Jellyfin.

A **Watch Next** entry now appears in the left-hand drawer for every user. There is nothing to configure per user.

If the entry never shows up, check the server log for a line from `WatchNext` — it says explicitly when the File Transformation plugin could not be found.

## Using it

- Open **Watch Next** from the navigation — the drawer on a phone or on the TV layout, the top bar on a desktop.
- Type in the search box to find a movie or show and pick it from the results; it is added to the bottom of the matching list, so it never displaces what you had already queued up next. Only things you have not watched yet are offered.
- Drag by the handle on the left of a row to move it. The new order is saved as soon as you let go.
- Tap the title to jump to the item's detail page and play it.
- Use the ✕ to drop something you no longer want; otherwise just watch it and it removes itself.

## Configuration

The dashboard page (**Dashboard → Watch Next**) only affects presentation — no setting is required for the plugin to work.

| Setting | Description |
|---|---|
| Menu label | The wording used for the drawer entry and as the page title |
| Show the entry in the navigation drawer | Turn off to stop injecting anything into the web client. Lists are kept and the API stays available |

## How it works

Jellyfin's plugin pages are all rendered inside the admin dashboard, and there is no server-side extension point for a page ordinary users can reach. So the user-facing half of this plugin lives in the web client instead: the **File Transformation** plugin is asked to append a few lines to `index.html`, which fetch `client.js` from this plugin once a user is signed in.

That script does two things. First, it adds the navigation entry — by cloning a neighbouring one and relabelling the copy, so it inherits whatever classes and structure that version of the web client uses instead of relying on hard-coded markup. There is more than one place to put it: below Jellyfin's `md` breakpoint the modern web app renders a sliding drawer, and above it the drawer is not in the page at all and the user views live in the top bar instead, which is what desktops and TVs see. The TV layout is different again — it runs Jellyfin's *legacy* app, with its own drawer and hash-based routing. All three are handled, and each is tracked separately, because resizing the window swaps which one exists.

Second, it draws the page itself as a full-screen overlay rather than registering a route, because Jellyfin's router is not a public extension point and its shape differs between the two apps. The browser's back button still closes the page, since opening it pushes a history entry.

Everything the page does goes through a small `[Authorize]` API on the server (`/WatchNext/...`), which resolves the stored ids against the library, drops anything that has since been deleted, and persists the two orders. A background service listens for watch-state changes and takes finished items off the list.

Because there is no NuGet package for File Transformation — and because plugins can end up with their own copies of `Newtonsoft.Json` in separate load contexts — the registration call is made entirely by reflection, building the payload out of File Transformation's *own* `JObject` type. That means this plugin carries no JSON dependency of its own, and retries for a couple of minutes in case Jellyfin happens to load File Transformation after it.

## Building

```sh
dotnet build --configuration Release
```

`JellyfinVersion` selects which Jellyfin packages to compile against (default `12.0.0`, the oldest supported server):

```sh
dotnet build --configuration Release -p:JellyfinVersion=12.1.0
```

Releases ship a single `net10.0` build compiled against the oldest supported Jellyfin. Jellyfin's assemblies are not strong-named, so the runtime does not pin the referenced versions and one build binds across the whole 12.x line; CI compiles against newer Jellyfin as well so an API change shows up there rather than in the wild.

## License

[MIT](LICENSE)
