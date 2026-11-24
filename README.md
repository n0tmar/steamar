# SteaMar

One local app for a Steam library: search a title, resolve its depots, write the Lua, keep the client in sync.

This folder is the app, and it is its own root: the engine resolves `ui/`, `config/`, `vendor/`,
`out/` relative to here, so a portable copy is this folder plus `runtime/node.exe`. Every command
below runs from here.

The app holds no supplier data. Depot keys, access tokens, the title index, the Denuvo list and the
fix catalogue come from the SteaMar service, whose code is private, over a signed call from
`src/api.js`. Point a build at a server with `config/steam.json` → `api.base` and `api.public_key`
([Pointing a build at a server](#pointing-a-build-at-a-server)).

The installer is on [steamar.cc](https://steamar.cc). Questions, builds and bug reports:
**[Discord](https://discord.gg/UkdAQ8q8Et)**. A security problem: [SECURITY.md](SECURITY.md). The
code is under the [MIT license](LICENSE).

```
npm run app        # the desktop app: native\build\Release\SteaMar.exe
npm run build:app  # build it from native/ (CMake + MSVC + WebView2 SDK)
npm start          # the same UI in a browser on http://127.0.0.1:8788
npm run verify:app # drive the real window: selection, in-app dialogs, denuvo tag, error dialog
npm run verify:setup # first run on an empty copy: download, repair, set up (about a minute)
npm run smoke:app  # open the built window on a throwaway service and a fake Steam folder; clicks nothing
npm run icon       # rebuild the .ico and the rail logo from logo.png
npm run portable   # stage a folder that runs on a PC with nothing installed
npm run doctor     # state of runtime, data, stplug-in, process
npm run check:views # every view drawn from a real engine's answers, no browser needed
npm run check:ui   # the door and the corner profile, in every state the service can be in
npm run drift -- --update
npm run bootstrap
node tools/add-games.js 1091500 --dry          # add by app id, name or --trending N; never opens the installer
node tools/add-games.js --index "witcher" --limit 3   # match titles against the local download index
node tools/boot-cost.js   # payload and timings for one full first paint
```

No dependencies for the web build; Node 20 or newer for the engine. The desktop app is C++ and
needs the Visual Studio build tools + the WebView2 SDK — see [native/README.md](native/README.md).

## At a glance

| | |
| --- | --- |
| What lives here | The desktop app: the engine (`src/`, a Node server on 127.0.0.1:8788), the page it serves (`ui/`), the native window that shows the page (`native/`, C++ that no test builds), and the checks (`test/`, `tools/`). |
| Entry point | `src/server.js` (`npm start`). The native window starts the same file. |
| Tests | `npm test` for the unit tests, `npm run check:ui` and `npm run check:views` for the page without a browser. `npm run test:e2e` is not part of it: it calls an engine already running on port 8788, which reads the real Steam install. |
| Must never | Hold supplier data: depot keys, tokens and the title index come from the service over a signed call. Take orders from a page on another origin: `src/origin.js` refuses them. |

## Desktop app

`SteaMar.exe` is the product: one window, dark frame, WebView2 with the UI served from `ui/` over
a virtual host, and the API answered in-process. The first routes are already native (`status`,
`pick-folder`, `reveal`, `install`, `cache/clear`, `text-size`); the rest are forwarded to
`src/server.js`, which the app starts itself and stops with the window. The UI is identical in
both worlds — it uses the message bridge when the shell is present and `fetch` otherwise.

The window is fixed at 1180x760: no resize handle, no maximise box, only minimise, move and close.
Every layout in `ui/` is drawn for that width, so a stretched window would only add empty space.
Only the position is remembered (`out/window.ini`), and the size follows the monitor's DPI so it
looks the same on a 100% and a 150% display. To read bigger type, use **Settings → Display → Text
size**, the last group on that page: a slider from 100% to 130% that applies as it moves, because the
whole page is the preview. A fresh copy opens at **115% (large)**, and the choice is remembered.

That fixed size is enforced from the constant, not from the window's current rectangle. Windows asks
a window for its min/max track size on every activation, not just on a resize, and those questions
also arrive while the window is being created, minimised or restored. Answering with *whatever the
rectangle is right now* pins the window at that size — which is how a window can end up as nothing
but a title bar with a minimise and a close button, stuck until the app restarts. Snap and Win+arrow
are refused the same way, and `WM_SIZE` puts the window back if the shell hands it a different size
anyway (`size: … corrected to …` in `out/native.log`).

| Part | Where |
|---|---|
| Window, single instance, size, text size, `--shot` | `native/src/app.cpp` |
| Routes, native first then engine | `native/src/api.cpp` |
| `config/steam.json`, registry, Steam process | `native/src/config.cpp` |
| Files, strings, project root, log | `native/src/core.cpp` |
| Icon resource and version block | `native/src/steamar.rc` |

### The page, checked without a browser

There is no browser in the build environment, and "open the app and look" is not a check anyone can
run twice. So the page is loaded against a stub DOM in Node and asked to draw: `tools/check-ui.js`
does it for the door and the corner profile in every state the service can be in, and
`tools/check-views.js` does it for the status bar, the library, the shelves, the fixes list, the
search page, the settings page and the game window.

The answers those views draw from are not invented in the check. They are captured from a running
engine into `test/fixtures/views/payloads.json` and replayed, so a fixture cannot agree with a page
that is wrong:

```bat
npm run check:views                                  :: replay the fixtures, offline
node tools\check-views.js --record --base http://127.0.0.1:8788   :: capture them again
```

Each view is failed three ways: it draws nothing, it prints `undefined`, `NaN` or `[object Object]`
where a fact belongs, or it says something the data does not support - the installed count on the
shelf must equal the installed titles in the answer, and each card carries the tags its row implies.
The recorder redacts the address, the Discord id, the device id and the avatar, because a fixture is
a fixture.

Two console-only warnings are expected and harmless. The page is served from
`https://steamar.cc` on a virtual host while art comes from the engine's loopback port, so Chromium
logs `Mixed Content: ... requested an insecure element 'http://127.0.0.1:8788/img/...'` for every
cover; the images still load, and the console is closed in a release build. Removing the warning
properly needs `api.cpp` to answer `https://steamar.cc/img/*` itself through a
`WebResourceRequested` handler and a deferral, which is not worth the risk to working art yet. The
second is `log.warning` noise from the same fetch path in a devtools session.

## Brand

Cat mark, name `SteaMar`, one accent that only ever means *you are here* or *this is live*.

| Role | Token | Hex | Used for |
|---|---|---|---|
| Window | `--window` | `#090A0D` | the pane, page background |
| Rail | `--rail` | `#0B0C10` | sidebar, status bar |
| Row | `--row` | `#0E1014` | card and group body |
| Row hover | `--row-hover` | `#13161B` | row under the pointer |
| Popup | `--popup` | `#0B0C0F` | game window, toast, chips, inputs |
| Popup hi | `--popup-hi` | `#15171B` | popup hover, empty art tile |
| Field | `--field` | `#20242B` | button fill, popup edge |
| Line | `--line` | `#171A20` | container edge |
| Line soft | `--line-soft` | `#12151A` | row separator |
| Text | `--text` | `#D4D7DC` | names, card titles |
| Sub | `--sub` | `#8C93A0` | values you read: size, players |
| Muted | `--muted` | `#484E58` | hints, captions, counts |
| Header | `--header` | `#5A6270` | group and shelf titles |
| White | `--white` | `#F4F5F7` | page title, brand, game window title |
| Accent | `--accent` | `#91A5D4` | the cat mark, selected nav, primary button, live dots |
| Accent hi | `--accent-hi` | `#A8B8DF` | hover on accent |
| Accent ink | `--accent-ink` | `#090A0D` | text on accent fill |
| Accent 08 | `--accent-08` | `#1C1C23` | selected nav fill |
| Accent 16 | `--accent-16` | `#2A2732` | selected chip fill |
| Accent 32 | `--accent-32` | `#463F51` | focus border, active chip edge |
| Success | `--ok` | `#55D98A` | running, in library |
| Danger | `--bad` | `#E45A67` | broken, denuvo, failed |
| Warn | `--warn` | `#EB9628` | empty or broken entry |

Rules that keep it flat: three surface tones and a popup, 2px corners, 1px hairlines, no gradients except the banner scrim, no blur, no shadows, hover never lifts anything. `--field-hi` (`#262B33`) is the only derived tone — neutral button hover.

## Icons

One family, drawn on the same 24×24 box as Feather and Lucide, stroked at 1.6 with round caps and
round joins, never filled except the Discord mark. `ICON` in `ui/format.js` is the only definition:
`icon('plus')` for anything a script builds, and `<i data-icon="gear">` in `index.html` for the rail
and the search field, which `paint_icons()` fills at boot. That placeholder is `display: inline-flex`
with `line-height: 0` and a `display: block` svg inside — an svg is an inline element, so put straight
into a plain block it sits on a text baseline and lands about 3px above the middle of its button. Sizes come from context — 14px in the
rail, 13px on a button, 12px on a small button, 9px in a card tag — and the
stroke stays 1.6 so the same glyph reads the same at every size.

| Glyph | Means | Where |
|---|---|---|
| house | home | rail |
| 2×2 grid | library, and the grid of covers it opens | rail |
| gear | settings | rail |
| magnifier | search | search field |
| circular arrow | rescan, refresh, repair | topbar, setup, repair button |
| plus | add | game window |
| down arrow onto a line | add & install, download, set up | game window, setup |
| folder | change or open a folder | settings, setup |
| bin | remove, clear | game window, settings |
| tick | in library, in place | cards, settings |
| triangle with `!` | broken entry, warning | card tag, setup |
| chevrons and × | banner, game window, dialog | everywhere |

Icons are one stroke family — 24 box, `currentColor`, 1.6 stroke — declared as `ICON` in `ui/format.js` and dropped into a control with `icon('trash')`. They always ride next to a label, so they stay 13px in a button, 12px in a small one and 9px in a card tag. The Discord mark is the single filled glyph: it is a logo, not a control.

**The rescan button** in the top bar is that circular arrow. It re-reads everything the app shows —
the scripts on disk, the counts, the folders, the store shelves — dims itself and sets `aria-busy`
while it runs, and answers with a *Library refreshed* toast. Its glyph is one arc plus an arrowhead
whose corner lands on the arc's tangent; an arc with a bare tick beside it collapses into a "C" at
14px, which is what it used to look like.

### Logo and icon

`logo.png` in the project root is the only artwork file — the periwinkle cat, `#91A5D4` on
transparency. `npm run icon` regenerates everything that needs it:

| Output | What it is for |
|---|---|
| `native/assets/steamar.ico` | 16, 24, 32, 48, 64 as DIB and 128, 256 as PNG — Explorer, taskbar, alt-tab and shortcuts each get a frame drawn at their own size instead of a stretched 32px one |
| `ui/logo.png` | 128px copy for the rail mark, the first-run heading and the browser tab |

`native/src/steamar.rc` embeds the icon as resource 1 and adds the version block, so the exe shows
up as *SteaMar — shared game library* with the right icon in Task Manager, Properties and the
taskbar. The mark sits directly on the rail: at `#91A5D4` on `#0B0C10` it does not need a chip,
a ring or a glow behind it.

## Views

| Route | What it holds |
|---|---|
| `#/home` | rotating banner, led by the games the owner picked in the console (one slide each, up to 12; the head of each shelf when there are none), then the owner's eighty games in six shelves (AAA / Open World, Action / Adventure / RPG, Survival / Building / Simulation, Horror / Story, FPS / Action, Strategy / Indie / Other), listed in `src/home.js`. Home asks the store nothing. No prices anywhere, and shelves below the fold skip layout until you scroll to them |
| `#/library` | every script in stplug-in, a to z, as a wall of tall covers (Steam's 600x900 library art); under each name one line says where it stands: installed, ready to install, needs repair, or can't download yet |
| `#/fixes` | the online-fix catalogue, in four shelves: for your games, trending, added this week, then everything else newest first, drawn sixty rows at a time as you scroll |
| `#/settings` | four groups: folders, helper files, your library and cached art, version |
| `#/search?q=` | the store search as a page of cards, like the library: Steam's results, then the service's index for titles the store hides; a card says not available (SteaMar has nothing to add for it yet), removed from steam (Steam's own record says the store no longer sells it, so a free one is offered for adding, not sent to Steam), in library or denuvo. Two icon buttons left of the search field, Not available and Removed from Steam, are off with every start and hide those two kinds; the page says how many it hid, and a game already in the library is never hidden |

### Fixes, in plain words

Each row is a game, its cover, one state tag, and a **Download** button. Pressing it asks the service
for the resolved file (`GET /api/fixes/link` → `/v1/fix/link`) and shows a three-line note: the browser
opens, unpack with the password, copy the files into the game folder. There is no copy-link button,
nothing is downloaded by the app, and the password copies through the engine rather than the page, so
it works even when the window is not focused (`POST /api/clipboard`).

A row appears in exactly one shelf. **for your games** is every release whose game is already in
your library; **trending** is Steam's live most-played chart; **added this week** is what went up in
the last seven days; **recent** is everything else, newest first. Searching replaces the shelves with
one flat list.

Every press of Download also teaches the app something: a link that resolved means that release
carries a fix of its own, so the answer and the file name are written back to the index
(`onlinefix.remember`). The list gets better with use, without another crawl.

### Check my setup

The setup sheet carries a quiet **Check my setup** button in its footer. It runs five checks in the
window: Steam is installed, the three helper files are in the Steam folder, games can be added,
SteaMar is connected, the fixes list is loaded. The button is plain text while everything is fine and
grows a small amber warning mark when a check fails, so the mark itself is the signal. The sheet
runs the check each time it opens and forgets it on close, so the mark is never stale. Green lines
mean nothing to do; red says what is wrong in plain words and offers Discord. Nothing touches the
network, so it answers offline too. Error codes and device ids stay in the log, not in the dialog.

There is no Denuvo filter any more. The shelves and the library always show everything, and a title
that uses Denuvo says so on its own card with a red shield mark (a game's states are round marks in the corner of its picture, the word in the tooltip) — the mark stays, the chips are gone, so
nothing can be hidden by a switch someone forgot they pressed. `#/home?df=…` and the `df` key in
`localStorage` are gone with it.

That tag travels with the game rather than staying on the cover: **GET /api/search** carries `denuvo`
on every result, so a search result shows the same chip on its card, and **GET /api/app** answers it
for the panel, which puts it under the title in the head. The panel takes the answer from the library
record, the card that was pressed, or the details call, whichever arrives first, so the chip is
there immediately and cannot be contradicted later by another source. A game without it has no chip
and no gap where one would be.

### While the store loads

`#/home` never says it is reading the store. It draws the page it is about to show: a block where
the banner goes, a bar where each shelf title goes, and four cards a shelf at the size a real card
takes. The numbers come from the real page, not from taste: a 242px banner, a 139px card split into
its artwork, its name line and its line of small print, a 27px shelf head. When the store lands,
nothing moves and nothing jumps.

One wide highlight passes over the blocks in 1.5s, and each card in a row starts 90ms after the one
before it, so a shelf reads as one wave instead of four blinking boxes. A machine that asks for
reduced motion gets the same blocks with the highlight breathing in place (2.4s, opacity only): a
sign of work, with no travel.

The blocks sit two steps above the page and never bright enough to be mistaken for content. If the
fetch fails, the skeleton gives way at once to one line, the reason, and a `try again` button. A
skeleton is a promise about what is coming, not a resting state to sit in. `tools/verify-app.js`
holds both halves: it compares the skeleton's banner, card and offsets against the real page at
runtime, requires the blocks to lift at least 12 levels off the page, and requires an animation to
be running, the sweep or the breath when motion is off.

### Starting fast

The opening view draws as soon as the library, the status bar, the setup state and the game count
are in, which takes a few milliseconds on an engine that is already running. Anything slower comes
after the first paint, or from disk:

- the store front is kept on disk for 30 minutes, so Home opens with its shelves instead of waiting
  for Steam, and the last copy stays up when Steam does not answer;
- whether a game has a wide banner picture is asked of the CDN once a week, not at every start; a
  host that did not answer is asked again next time;
- the repair check, which hashes the helper files, and the facts for Settings are asked after the
  first paint;
- the Fixes tab draws its short shelves and the first sixty rows of *All fixes*, then the next rows
  as the end of the list comes near. Two thousand rows used to hold the tab for half a second, most
  of it spent building a date formatter for every row.

### Moving smoothly

The window moves at the site's pace, which is the landing page's: what leaves fades out in 0.22 s,
what arrives fades in over 0.38 s a beat later. `ui/motion.css` holds all of it. Switching views is
a crossfade (`router.js` asks for a view transition, and the rail, the bar and the status line stay
where they are); a panel, a dialog and the sign-in screen fade in as they open; every cover fades in
when it arrives (`events.js` marks it); the Home banner crossfades between games; and lower down a
view, shelves and cards fade in as they are scrolled to. Fades are for everyone. When Windows is set
to show fewer animations, nothing slides or zooms.

## Denuvo

Steam has no DRM flag to read — a store page does not say "Denuvo" anywhere an API would return — so
the list is an owned file, not a download from someone else's repo:

`config/denuvo-titles.json` — 79 titles, one per line, spelled the way Steam spells them where
possible, plus an `aliases` map for the ones it spells differently (`F1 2023` → `F1 23`,
`SONIC X SHADOW GENERATION` → `SONIC X SHADOW GENERATIONS`) and a `manual` map for ids the store
cannot answer. The app does not read this file. The service's importer copies it, with the ids
in `data/denuvo-appids.json`, into the service, and the app takes the list from the service when its
engine starts. A running service keeps the old list until it is restarted.

A title is matched two ways, and either one is enough:

- **by name** — both sides are normalized (symbols such as `™®©` to a space *before* Unicode
  decomposition, then accents dropped, lowercased, punctuation to spaces), so `Avatar: Frontiers of
  Pandora™` and `avatar frontiers of pandora` are the same string. It needs no app id at all.
- **by app id** — the service resolved each title to an id once (full title, then the part before
  ` - ` or `: `, then each alias) when the list was imported, and hands over `{ name, appid }` pairs.
  The scoring rejects near-misses so a DLC or an edition cannot stand in for the game: exact name
  beats a prefix (`Hogwarts Legacy: Deluxe` is rejected for `Hogwarts Legacy`), and `dlc`, `pack`,
  `bundle`, `soundtrack`, `upgrade`, `expansion`, `season`, `demo`, `lite`, `points` are refused
  outright.

All 79 resolve. Three of them — `EA SPORTS FC 24`, `F1 2023`, `NBA 2K25` — are not on the store here
(the search finds nothing, or finds a mod with the same name), so their ids are pinned in the server's
copy of the list:

```json
"manual": { "EA SPORTS FC 24": 2195250, "F1 2023": 2108330, "NBA 2K25": 2878980 }
```

A pinned id is used before any search, and each was checked once against Steam's own
`appdetails` (`2195250` → *EA SPORTS FC™ 24*, `2108330` → *F1® 23*, `2878980` → *NBA 2K25*), so a
title the store cannot answer is not a guess. Nothing breaks when the service cannot be reached:
no card is tagged until the list arrives, and everything else works.

Store search is a page, like the library: type two characters in the top bar and the results fill the page as cards, and each letter after that redraws them in place. Emptying the field, or Escape, goes back to the view the search started from; the address holds the query, so Back and a reload keep it. Clicking any cover opens the game's window over the middle of the page, and what it offers depends on the state of that app id:

| State | Buttons |
|---|---|
| not in the library | **add to library** and **add & install** |
| free on Steam | **get it on steam**, and **add to library** dimmed with the reason |
| free, and it is a demo | same, with the reason saying the demo *is* the product |
| free, and not out yet | **open the store page** (`steam://store`), and **add to library** dimmed: nothing to install yet |
| broken script | **repair** and **remove** |
| in the library | **install** and **remove** |

**add to library** writes the script and stops — nothing downloads, no installer opens. **add & install** does the
same write, then hands the app id to Steam (`steam://install/<appid>`) so Steam runs its own install
dialog. The two are separate calls, and the write finishes first: an install that fails cannot be
reported as a failed add, and the window still shows the game as added. `/` focuses search, Escape
closes the window. Every window, dialog and the shade behind them fades in as it opens and out as it
closes, at the site's pace (`ui/motion.css`).

**Under the buttons the panel says what the game is.** It comes from Steam's own page for that app
id: one sentence of description, then `released`, `by`, `genre` and `players`. That is one call
(`GET /api/app`), made after the panel is
already usable, kept for a month beside the rest of the cache, and silent when the store has no page
for an id: a delisted game keeps its buttons and gains no invented text. No price appears anywhere in
the panel; free is a word there, never a number.

**The free verdict has its own clock, one day long.** It is the one field that can change under a cached
record: a paid game goes free, a demo gets its own page, a free game ships. So the month belongs to the
prose, and `is_free` is re-asked on its own once a day with `filters=basic` (about 6 KB) when a panel
opens on an older record. The second open that day costs nothing, because the answer is stamped with
the record as `free_at`. A store that will not answer leaves the last verdict in place and resets the
stamp, since a panel that waits on a dead network is worse than a flag a day out of date. Nothing here
is a list: an app id nobody has opened has no record at all, so its first open is a live question.

**A free game needs no help.** When the store says `is_free`, the panel says *Free on Steam!*, the main
button becomes **get it on steam** and hands the app id to Steam, which installs it like any other free
game. **add to library** stays in the row, dimmed and marked `aria-disabled` instead of being removed,
because a missing button reads as a bug while a dimmed one with a reason reads as a decision. The reason
is in three places, each shorter than the last: the tooltip (*free on Steam. nothing to add. save the
tricks for the games that charge.*), the line under the buttons, and the toast that answers a press
(*free. nothing to add. the store is giving it away*). A dimmed button that is still in the tab order
and still answers a press is worth more than one that silently does nothing.

A free game that is already in the list gets the same dry tone instead of a lecture: *free on Steam the
whole time. no harm done.* The script was never needed, and nothing about it is broken.

**The verdict is one field, and it is the store's own.** `GET /api/app` passes `is_free` through from
appdetails, and the page reads nothing else. Checked against eight ids the store is never wrong about
(CS2, Dota, TF2, Apex, Lethal Company, Elden Ring, Black Myth, Wallpaper Engine) it answered every
one correctly, and the same id answers the same in us, de, tr, br, ru and cn, because the field
describes the app rather than a price in a currency. Three cases needed their own sentence: a demo
(`type: "demo"`) answers `is_free: true`, so the panel says it is a demo instead of pretending the
game is free; a free game that has not shipped answers `is_free: true` while its installer does not
exist yet, so the panel offers the store page, where the wishlist button lives; and a 100% discount
or a free weekend leaves `is_free: false`, which is the helpful answer, since claiming a promotion
really does put the game in the library. An id the store will not describe comes back `{missing:
true}` and the panel keeps its ordinary add buttons rather than guessing from nothing.

The panel behaves like a window, not a page. The title and the way out stay pinned while the text
scrolls, opening it takes focus and puts the grid behind out of reach (`inert`), closing it hands focus
back to the card that opened it, Escape closes it, and a refresh that lands while it is open no longer
shuts it.

The cover sits in one box, 460 by 215 and cropped to fill, so a header and a library hero land in the
same shape and the panel does not move when the art arrives. The page cannot build that path itself:
in the desktop shell a bare `/img/` address resolves to the virtual host, which serves nothing, so the
address comes from the card that was pressed or from the same details call.

### Remove, then add again

The proxy seeds its injected license table **once per Steam process** (`InitFakeLicenseOnce`), then
only edits it in place. Deleting a script while Steam runs takes that app id out of the table, and
that part is live; writing the same id back in the same session has nothing to land in, so Steam
answers *no license* when the game is started.

SteaMar tracks it. A removal made while Steam is running is stamped in `out/removed.json` with the
`steam.exe` pid that lost the license, and the next add of that id — same pid — answers
`steam_restart_needed` and asks one question: restart Steam now, or later. Restart is the only move
that rebuilds the table, because the scripts on disk are already correct. A stamp from an older pid
is spent: it is pruned on the next add, so closing Steam by hand clears the notice by itself. Nothing
is asked when Steam is closed at removal time — the next start reads every script anyway.

## First run

A new copy has nothing in the Steam folder and no game data, so the app opens a setup panel by
itself and does the fetching:

1. **Steam folder** — found from `HKCU\Software\Valve\Steam\SteamPath`, then the two usual install
   paths, then whatever is stored in `config/steam.json`. Change it with the native folder picker
   if Steam lives somewhere else. A folder without `steam.exe` in it is refused, so a typo cannot
   "set up" a folder that was never Steam.
2. **Files SteaMar needs** — one button downloads the three helper files, unpacked from the pinned
   release in `config/steam.json` into `vendor/` beside the exe (1.2 MB, plus `opensteamtool.toml`
   from `tools/`).

   That is the only download left. The game list, the keys and the tokens are not files any more:
   they come from the service, and `config/steam.json` → `api.base` + `api.public_key` is where the
   app is told which one to ask.

   Every helper file must match a SHA-256 that `config/steam.json` names for its source, because these
   files run inside Steam. A download that does not match is refused, and so is a folder picked with
   `choose folder` that holds any other version. The step is skipped when the files in `vendor/`
   already match, so pressing the button again is a cheap check, not a re-download.

   Pressing it also repairs a broken copy — a truncated DLL is fetched again instead of trusted.
3. **Set up** — copies the three DLLs and the TOML into Steam and creates `config\stplug-in` and
   `depotcache` if they are missing. It needs Steam closed, because Steam locks loaded DLLs. The
   TOML is the default from `tools/opensteamtool.toml`: logging and manifest download on,
   injection off, and no `[[inject]]` rows until you add one.

The job runs in the engine and the panel polls it, so a 16 MB download never sits inside an open
request. Failures are shown in the step, in red, with the reason — a 404 from GitHub, no network,
a full disk. If the first source in `vendor.sources` is down the next one is tried, and the step
names the one that worked. A copy still missing after a download is caught: the app counts the
bytes it wrote and re-reads the JSON before it reports success.

Two errors a person can actually hit get a sentence instead of a code: `Steam is running and locks
those files — close Steam, then press set up again`, and `Windows would not let SteaMar write to
<path>. Run SteaMar as administrator and try again` (Program Files is protected on machines where
it is). The panel only appears while something is missing, is dismissible ("later"), and can be
reopened from Settings → Helper files. **remove** takes the three DLLs and the TOML back out and
leaves every added game in place.

Until the game list is there, `#/home` says so and offers one button that opens this panel, instead
of showing an empty shelf.

## Portable

`npm run portable` stages `out/portable` — or the folder you pass: `npm run portable -- D:\USB`.
Copy it anywhere and run `SteaMar.exe`:

```
SteaMar.exe          the app
SteaMar.bat          same thing, for Start menus and shortcuts
runtime\node.exe     the engine's own runtime - the PC needs nothing installed
src\  config\  tools\  ui\
vendor\              helper files, when they have already been downloaded
data\                denuvo app ids, when they have already been resolved
out\                 logs, window.ini, caches; created on first run
```

This copy needs no installer, writes no registry and holds no absolute paths.
The exe looks for the engine's runtime in
`runtime\node.exe` first and only then on `PATH`, so a machine without Node still runs it. The
game list is served, so a fresh folder downloads nothing into itself, `npm run portable --
--zip` also writes a `.zip` next to it, and nothing outside the folder is written except the three
helper files that setup puts into Steam.

The zip is the artifact a release publishes as an update, and the installer (below) is what people
download. A lone `SteaMar.exe` is neither: it looks for `ui\` and
`config\` beside itself and opens a blank window without them.

Where the copy looks for its service is a packaging decision:

```
npm run package                                    # out/SteaMar-<version>-win64.zip and -setup.exe, config as it is
npm run package -- --base https://steamar.cc       # the address a handed-out copy should use
```

`--base` (or `STEAMAR_API_BASE`) rewrites `api.base` in the staged `config\steam.json` and nothing
else; the pinned key stays in the config, because a build that asks the user for a key has no pin.
At run time `STEAMAR_API` overrides the address for one launch, which is how the shipped zip is
tested against a server on this machine:

```
set STEAMAR_API=http://127.0.0.1:8791
SteaMar.exe
```

One copy runs at a time. The window talks to the engine on `127.0.0.1:8788`, so the engine reports
which folder it belongs to (`/api/status` → `root`) and the shell refuses to reuse one from a
different copy — otherwise a second SteaMar would install into the first copy's Steam folder while
showing it as its own. Starting a second copy says so and closes.

A PC without the WebView2 runtime cannot draw the window. Instead of a blank frame, the app says
what is missing and offers to open Microsoft's installer; it is the only thing the app does not
carry itself.

## Installer

`npm run package` writes two files side by side. `SteaMar-<version>-win64-setup.exe` is what the
download page offers. `SteaMar-<version>-win64.zip` is what a release publishes, because the app's own
updater installs from it. The installer is the same staged folder, compiled by Inno Setup 6 from
`native\setup.iss` (`winget install JRSoftware.InnoSetup`, or set `ISCC` to its `ISCC.exe`).

It installs for the signed-in Windows account, into `%LOCALAPPDATA%\Programs\SteaMar`, with no
administrator prompt: the updater copies each release over that folder, so it has to be one the
person can write to. It adds a Start menu entry, a desktop one when asked, and an entry in Windows'
installed apps whose version the updater keeps current. It waits while SteaMar is open.

Run over a copy that is already there, it replaces the program and merges `config\steam.json` by the
updater's rule: the release's service and key, the person's Steam folders
(`src\update-apply.js --config`). Uninstalling removes the program, the helper files and data it
fetched, and the caches. The device key, the backups of game scripts, the logs and
`config\steam.json` stay in the folder, so a reinstall finds them. It does not take the three proxy
files back out of Steam; **Remove** in the app does that.

Neither file is code-signed, so SmartScreen warns the first time somebody runs one. An installed copy
is checked like a build: `set STEAMAR_EXE=<folder>\SteaMar.exe`, then `npm run smoke:app`.

## Your account

The account is not in Settings. Pressing the profile at the foot of the rail (picture, status dot,
name, @page and role) opens a small window inside the app that is the person's card as their public
page draws it, without the games: the banner picture (or the page background), the picture with its
frame and status dot, the custom status beside it, the name with the role's mark at the end of the
line (its word on hover), @page and pronouns, About me, the links as marks, then member since, donor
since with the number of donations, a line when the month is paused, and **Sign out** and **Donate**
at the foot (the x or Escape closes it). The status is the person's own, so invisible shows as
invisible here, as Discord shows you yourself. A member or donor also gets the link to their page
(`steamar.cc/@name`, a bought name or the owner's `@1`) with **Copy**, which goes through the
engine's clipboard like a fix's password, and **Edit profile** and **View page**, which open the site's
profile editor (`/account/profile`) and the page itself in the browser, through `POST /api/profile`
the way Donate goes through `POST /api/donate`. A link mark opens the same way, by its place in the
list (`{ link: 2 }`): the engine takes the address from the account it holds, so the window never
hands it one. The card comes with the account (`profile` in `/v1/me`), so the window asks nothing
when it opens. Sign out asks first, then calls
`POST /api/logout`, which asks the service to forget this PC (`POST /v1/link/forget`, signed by the
PC) and answers with the account it now has, so the window goes straight to the sign-in screen. The rail's only other button is **Donate**, drawn as a button.

## Settings

| Group | Does |
|---|---|
| *(status card)* | opens the page: whether Steam is set up, in one sentence, with the one action that belongs there — **Set up** when it is not, **Remove** when it is |
| Steam | the Steam folder with **Change** |
| Display | text size: a slider, 100–130%, large (115%) by default — scales the whole view, remembered in `out/window.ini` |
| About | version, the update row, and **Discord** for help |
| Advanced | closed by default: the game files folder (`stplug-in`) and the manifest folder, each with **Change** and, once changed, **Reset**; saved pictures with **Clear**; the app folder with **Open** |

The page opens with a **status card, not a group**: whether Steam has the helper files is a fact
about the app's health, so it is stated once at the top the way the status bar states it — a mark
(green check or amber triangle), a sentence (*Steam is set up · The helper files are in place.*),
and the single action that fits that state — **Set up** while it is missing, **Remove** while it is
there. When Steam is running and locks the files, the card says that is what is in the
way, and `set up` opens the panel that walks through it.

The card is the door to the checkup, but it is not the checkup: when something in the Steam folder
is wrong it says *Steam needs a small repair* and its one action becomes **Repair**, which opens the
setup steps — the only place a repair lives — on the step that fixes it. Nothing about files, sizes
or hashes is shown here; the card has three states (set up, needs a repair, not set up yet) and
each one names its own next step.

Below it come the account and the Steam folder, then Display and About. What a person almost never
needs — the two folders inside Steam, the saved pictures (`out/imgcache`) and the app folder — sits in
one **Advanced** group that starts closed, so the page shows what people open it for. Notes are
written in sentences; only paths keep the mono face.

Folders live in `config/steam.json` (`steam_root`, `stplug_in`, `depotcache`, `dll_source`). `STEAM_ROOT` in the environment overrides the root and disables changing it.

**Changing a folder.** Every `change` button opens a real Explorer folder dialog on the folder
that row already points at, so it starts where you are instead of where Windows happens to
remember, and the row's own question is the dialog's title (*"Where should the Lua files go?"*).
The dialog is owned by the app window and runs on its UI thread, so it opens in front of the app
rather than behind it; `Use this folder` is the confirm button, and cancelling changes nothing.

The path travels as the row key (`stplug_in`, `depotcache`, `steam_root`, `dll_source`), and the
shell resolves it from `config/steam.json` itself — so the dialog cannot open on a folder the page
only thinks is configured. If the stored folder has since been deleted, the dialog falls back to
the nearest parent that still exists, then the Steam folder, then Documents. `out/native.log` gets
one line per open: `picker: opening 'Where should the Lua files go?' in D:\Apps\Steam\config\stplug-in`.

The request is not held to the 30-second bridge limit every other call has: the page passes its own
`timeout` for this one call and waits ten minutes, so browsing for a folder can take as long as it
takes and the choice still lands in `config/steam.json`. A confirmed Steam folder with no
`steam.exe` in it is called out in a toast instead of only showing up later as "not set up".

The engine keeps a PowerShell `FolderBrowserDialog` fallback with the same starting folder for
when the page runs in a plain browser (no shell to host a Win32 dialog).

## Repair

An old install is the most common reason the same app works for one person and not another: a
leftover loader from a previous tool sitting in the Steam folder, a config whose `[[inject]]` rows
point at a payload that was deleted years ago, a proxy DLL from another era, a game list from
before the folder moved. Nothing in that list is visible from the outside, and all of it looks
like "the app is broken" to whoever owns the PC.

So the app checks the Steam side on its own. `src/repair.js` has two functions: `inspect()` reads,
`fix()` changes. `GET /api/repair` runs the first, on every launch; `src/doctor.js` runs it too, so
a dev machine reports the same faults before a user finds them.

**It lives in the setup steps, and only when there is something to fix.** There is no Repair group
in Settings and no findings list in the app: when the check finds something wrong, the setup panel
opens on a first step titled *Steam needs a repair first* — one sentence ("something from an older
setup is in the way") and one `fix it` button. Press it, and the steps below carry on from where
they were; on an install that was already set up, the panel ends on "SteaMar is set up" and Steam
is reopened. Nothing to read, nothing to choose. The names, sizes and hashes stay in `/api/repair`
and in `npm run doctor`, where a developer wants them.

The check is not a one-off, which is how an install that goes bad months later gets put right. If
the next launch finds something fixable and Steam is closed, the panel opens on that step again; if
Steam is running, the Settings card says *Steam needs a small repair* and its `repair` action opens
the same step.

What it looks at:

| Check | Finding |
|---|---|
| the Steam folder is really Steam | `steam-missing`, `steam-steamapps`, `steam-libraryfolders` |
| the three helper files are ours | `helper-source:<name>` (nowhere to copy from), `dll-missing:<name>`, `dll-stale:<name>` (a different file is in place — an older version, another tool's copy, or damage) |
| the config is valid | `toml-missing`, `toml-sections` (one of `[log]`, `[manifest]`, `[inject]` gone), `toml-dead-inject` (an `[[inject]] path=` that does not exist), `toml-all-games` |
| nothing else is loading | `foreign:<name>` for `version.dll`, `winmm.dll`, `d3d9.dll`, `dxgi.dll`, `dinput8.dll`, `msimg32.dll`, `opengl32.dll`, `uxtheme.dll`, `xinput9_1_0.dll`, `xinput1_3.dll`, `steam_api.dll`, `steam_api64.dll`, plus the ini files other loaders leave behind (`cream_api.ini`, `smartsteamemu.ini`, `goldberg.ini`, `ColdClientLoader.ini`) |
| the folder has no debris | `stale-copies` (`.bak`, `.old`, `.orig`, `.disabled`, `.backup` next to the live files) |
| the imported games are usable | `scripts-broken` (a `.lua` that will not parse), `scripts-nokey` (an `addappid` with no key, which Steam accepts and then refuses to install) |
| the folders exist | `folder:stplug_in`, `folder:depotcache`, `data-missing` (no game list yet) |
| Steam is closed | `steam-running` — not a fault, but it is why a repair has to wait |

Each finding carries `severity` (`blocker`, `fix`, `warn`, `info`), `fixable`, `kind`, the `action`
that suits it (`fix`, `choose`, `download`, `close-steam`, `none`) and one sentence of detail. The
summary is a single word the UI can act on: `blocked` when something must happen first, `repair`
when there is something to fix, `ok` when there is not.

**A fix never deletes anything.** Every displaced file is moved to
`out/quarantine/<ISO stamp>/<name>` (with a numeric suffix if a file with that name is already
there, and a copy-then-unlink across drives), so a repair is reversible by hand and an old setup
is preserved rather than destroyed. Then the shipped file goes in: the helper DLLs come from
`vendor/`, a damaged config is rewritten with the three required sections, the missing folders are
created, and the game list is fetched if it is missing.

**Steam is closed by the repair, not by the person.** The proxy files are loaded into Steam at
startup, so Windows holds them open: `POST /api/repair` with `close_steam: true` shuts Steam down,
waits for it to exit, applies the fixes and starts Steam again unless the caller asked for it to
stay closed (a first-run setup needs the folder quiet for the next step). If Steam will not exit —
a game is running — the answer is a 400 with that sentence, and the step stays put. Without
`close_steam` the route refuses instead of half-doing the job.

`out/probe-repair.js` builds a deliberately broken fake Steam folder (wrong `dwmapi.dll`,
a foreign `version.dll`, an incomplete TOML with a dead inject row, an unreadable `.lua`, no
`depotcache`), runs `inspect()` then `fix()` against it, and asserts the end state — three helper
files matching `vendor/vendor.json`, a config with all three sections, the broken scripts and the
foreign loader quarantined but still on disk, and a second `inspect()` that is `fixable: 0`.

## Selection, dialogs and errors

The window is a tool, not a document: text cannot be selected, dragged or copied. `html, body`
opt out of `user-select`, `*` opts out of `-webkit-user-drag`, `::selection` is transparent, and
a capture-phase listener cancels `selectstart`, `dragstart`, `contextmenu`, `copy` and `cut`. The
guard checks the target first, so fields are untouched — the search box and the settings inputs
keep a caret, text selection and normal copying. Editing keys survive as well: Ctrl+A, Ctrl+C and
Ctrl+V in a field are editing accelerators, not browser ones, so the lockout never reaches them.
Everything else is off at the controller: context menu, zoom, swipe
navigation, status bar, browser accelerator keys, pinch zoom and developer tools. Tab, arrows,
Enter, Escape and `/` all still work, and links leave for the real browser.

Confirmations and failures are drawn by the page, in the app's own surfaces — no
`confirm()`, no `alert()`, and no Windows message box. `open_dialog()` in `ui/dialogs.js` renders one
panel (popup surface, 1px hairline, 2px corners, an accent rail that turns red for a destructive
question) and resolves a promise: **true** for the main button, **false** for the way out.

- One dialog at a time. Opening another answers the first with `false`, so no question can be
  silently left hanging.
- Enter answers, Escape backs out, the main button takes focus on open, focus returns to whatever
  asked when the dialog closes, and everything behind it is `inert` while it is up.
- `ask({title, message, ok, cancel, tone, danger})` is the only way to ask. Messages keep their
  paragraphs (`white-space: pre-line`); destructive questions say so in the button and in the rail
  (`tone: 'bad', danger: true`).
- `alert_error(err, {title, retry})` is the only way to stop someone with a failure: the message,
  four lines of stack in a mono block, **close** or **try again**, and **ask in Discord** as the
  way out. It also writes the details to `out/native.log`.
- The one message box left in the shell is the WebView2 runtime prompt, because a page that cannot
  be drawn cannot draw a dialog either.

Every failure surfaces somewhere:

| Failure | What happens |
|---|---|
| Engine not answering at start | the error dialog (`SteaMar could not reach its engine`) with **try again**, instead of empty shelves |
| Set up fails (Steam running, protected folder, no `steam.exe`) | the reason stays in step 3 of the setup panel, in red, and in a toast |
| the service's Denuvo list cannot be fetched | nothing is tagged — a card simply has no `denuvo` chip — and everything else is unaffected |
| Uncaught script error | the error dialog: what broke, the first stack frames, retry or Discord; logged as `ui.alert:` |
| Unhandled rejection | toast, then `POST /api/log` → `out/native.log` as `ui.promise:` with the stack |
| Failed API call | JSON `{error}` with a status the UI can read; the message goes into a toast |
| Install refused after an add | the script is already on disk, so the game stays added; the toast names the install failure and says to install from the game's window |
| Engine 5xx, engine down, call slower than 1.5 s | a `proxy:` line with status and duration |
| Exception inside a route | 500 plus `api: exception on <path>: <what>`; `bad_alloc` has its own message |
| Unhandled C++ exception or access violation | `crash: code 0x… at 0x…` is written before Windows Error Reporting runs |
| Window shrinks to a title bar with only minimise and close | it cannot any more: the min/max pin comes from the fixed size, and `WM_SIZE` corrects a window the shell resized (`size: … corrected to …`) |
| Folder picker opens somewhere else, or behind the app | it opens on the row's own folder because the shell resolves the key from `config/steam.json` and calls `IFileDialog::SetFolder`; it is shown on the UI thread, owned by the window, so it cannot fall behind (`picker: opening '…' in …`) |

Request bodies over 1 MB are refused with a 413 before parsing, UI messages are capped at 2,000
characters and levels at 20, and multi-line text is flattened to ` | ` so the log keeps exactly
one line per event and stays greppable.

## API

| Route | Purpose |
|---|---|
| `GET /api/status` | counts and runtime state for the sidebar; `available` is how many games the tool can hand out |
| `GET /api/setup` | first-run state: which proxy files and folders are in place, where the files could come from |
| `POST /api/setup/install` | copy the proxy files + TOML into the Steam folder, create the Lua and manifest folders |
| `POST /api/setup/remove` | take the proxy files + TOML back out of the Steam folder; added games stay |
| `POST /api/setup/fetch` | start the download of the helper files and the game list; progress is carried by `GET /api/setup` |
| `POST /api/pick-folder` | body `{title, key, start}`: opens the native folder dialog on that row's folder and returns `{folder, started_in}`; 400 when cancelled |
| `GET /api/repair` | the checkup: `{steam_root, steam_running, findings[], summary{state, fixable, blockers, warnings, checked_at}}`; `state` is `ok`, `repair` or `blocked` |
| `POST /api/repair` | body `{only, close_steam, restart}`: applies the fixes and returns `{fixed, failed, state}`; with `close_steam` it shuts Steam down first and (unless `restart: false`) opens it again; 400 when Steam is running and it was not allowed to close it |
| `GET /api/library` | scripts with resolved app id, name and art, plus `installed` / `installed_bytes` from the client's own `appmanifest_<appid>.acf`, and `keyless` for a game script with no depot key |
| `GET /api/settings` | full settings payload |
| `GET /api/verdict?appid=` | one title's pre-flight (`/v1/verdicts` for a single id), including `report` when other machines have tried it; `null` when the service has no opinion. Used by the panel, which can be opened from the library, a fix or a deep link and so has no search result to borrow a verdict from |
| `POST /api/update-check` | the person pressing check: asks `/v1/latest` with the cache skipped and answers `{update}` (state, version, url, sha256, notes, `checked_at`) |
| `GET /api/update` | what the in-place update is doing: `{state, version, percent, error}` - the row polls this instead of holding a request open |
| `POST /api/update` | starts it: download, checksum, unpack into `out/update/stage`. The url and sha256 come from the signed reply, never from the page |
| `POST /api/update/apply` | the shell's route: starts `src/update-apply.js` and closes the window. In browser mode the engine refuses in one sentence |
| `POST /api/settings` | write `steam_root`, `stplug_in`, `depotcache`, `dll_source`; an empty string clears an override |
| `GET /api/search?q=` | store search: `appid`, `name`, `image`, `denuvo`, `supplier` for a hit that came from the service's index, and the pre-flight `renderable` / `reason` for every row (`/v1/verdicts`, one call per page) |
| `GET /api/store` | Home: banner, the owner's picks (from the account answer), and `shelves` (`title`, `games`) from `src/home.js`; no prices, and no store request |
| `GET /api/package?appid=` | depots, keys, manifests, warnings, `renderable` and `reason` |
| `GET /api/app?appid=` | what the panel says about one app: `description`, `developers`, `publishers`, `genres`, `players`, `release`, `coming_soon`, `free`, `free_at`, `denuvo`, `type`, `image`, `hero` (the wide art the window leads with); 30-day cache for the prose, 24-hour re-check for `free`; `{missing:true}` for an id the store will not talk about |
| `GET /api/reach` | addable titles as the service counts them (`/v1/reach`), plus the title, token and depot-key counts, the number reported failing and the worst few by app id |
| `POST /api/add` | generate the Lua, back up, atomic write into stplug-in, then send `POST /v1/report` with the outcome (unawaited: a failed report is not a failed add) |
| `POST /api/remove` | remove a script, keep a backup |
| `POST /api/restore` | restore a backup into stplug-in |
| `POST /api/cache/clear` | drop the lookup cache and the service mirrors |
| `POST /api/pull` | `git pull --ff-only` on the data repos |
| `POST /api/reveal` | open steam, stplug-in, depotcache, out, or project in Explorer |
| `POST /api/install` | hand an appid to Steam: `install` opens the installer, `store` opens the store page (for a free game that is not out yet), `play` still launches a game if called directly |
| `POST /api/steam/restart` | close Steam and open it again, so the injected license table is rebuilt from the scripts on disk; refuses and says so if Steam will not exit |
| `POST /api/log` | one UI warning or error into `out/native.log` |
| `POST /api/text-size` | `{percent}` 100-130 → `{zoom}`; the shell scales the whole view and remembers it. The engine has no such route on purpose: a browser tab has no controller, so the page uses CSS zoom there and never makes the call |
| `GET /img/<appid>.jpg` | 460x215 header, pulled from the CDN once then served from `out/imgcache` |
| `GET /img/cap/<appid>.jpg` | 231x87 capsule, the fixes list's fallback, same cache |
| `GET /img/hero/<appid>.jpg` | 1920x620 banner art, falls back to the header when a game has none |

## Resolution rules

A script's first `addappid` is not its app id: several shipped scripts list a depot first and the app last (`814380.lua` opens with depot `814381`). The library resolves the real app by asking appdetails about each candidate, file name first, then every id in the script.

Install state is read from the client, not inferred: an `appmanifest_<appid>.acf` in any library folder (the root one and every folder named in `libraryfolders.vdf`) carries `StateFlags`, and 4 is fully installed. A download in progress is therefore not "installed", which is what a person means by the word. The manifest is read, never written, so nothing here can disagree with Steam about its own disk.

A script can also be **keyless**: it parses, Steam accepts it, and nothing installs, because no depot in it carries a key. That is the checkup's line and the card's tag from the same test — `keys === 0` over a game script — so the two cannot say different things. When the title is already installed the tag is dropped: the files are there, and a warning about a download that already happened is noise.

What limits a title is **not** the access-token list. Tokens are only needed for apps Steam will not
authorize anonymously — delisted or region-locked ones — and there are 5,090 of them. The limit is
depot keys: `175,781` of them, and an app is addable when its depots have keys. Cyberpunk 2077,
ELDEN RING, GTA V and Sekiro all add with **no token at all**.

## The service

`src/api.js` is the only door out of this folder (its parts are `device.js`, `transport.js`,
`mirror.js` and `account.js`, and nothing else in `src/` requires them). The tables that used to live in `data/` — depot
keys, tokens, the title index, the Denuvo list, the fix catalogue — live in the service and arrive as
signed replies; nothing in this folder holds a copy of them for anyone to lift out of a public repository.

One handshake and then one signature per call:

```
out/device.key     ed25519, made on first run, never leaves the machine
out/device.json    { device_id, token, install_id } — the token is worth nothing without the key
config/steam.json  api.base + api.public_key — the one server this build trusts
```

```
request = v1 \n METHOD \n path \n query \n ts \n nonce \n sha256(body)     signed by the device key
reply   = { v, ts, device, body, sig }                                      signed by the server key
```

The nonce is single-use and the clock has a two-minute window, so a captured request cannot be sent
again and cannot be edited — the path and query are inside the signature. The reply is checked against
the pinned key before a single byte of it is used, so a proxy, a mirror or a hosts file cannot answer
in the server's place. A cached reply in `out/api/` remembers the key that signed it and is thrown away
when the pin changes.

What it changes in the engine:

- `catalog.resolvePackage` takes the depot list and the token from `/v1/package`, keeps the public
  manifests from SteamCMD, and joins the two per depot. If the service cannot answer, adding a game
  fails with that reason — there is no local table to guess from, and a script with no keys installs
  nothing.
- `GET /api/search` merges `/v1/search` after the store results; Steam's search answers ten at most, so the rest come from there. The
  store search cannot see delisted titles; the service can. A service that is down costs the extra
  titles, not the search.
- a delisted app in the library shows its real name instead of `app 12345`, from the same index.
- `GET /api/fixes/link?id=` asks `/v1/fix/link` and mirrors the answer for six hours. **This folder
  holds no resolver**: `src/fixes/` keeps only `scan.js` (reading a local folder of releases). The
  walking of online-fix, the hoster listings, the gofile salt and the mega key all live in the
  service, so the published client learns a url and never a method — and ten thousand installs
  clicking the same release are one outbound read on the server, not ten thousand on the host.
- `denuvo.js` and `onlinefix.js` hydrate from `/v1/denuvo` and `/v1/fixes` at boot and answer from
  memory, so a chip or a fixes row never waits on the network. Both lists are for members, so a PC
  that signs in after the engine started is refused them at boot: `GET /api/account` asks again for
  a list that never arrived once the account says somebody is in. The Fixes tab asks the engine each
  time it opens, and the engine's copy of the index is fetched again when it is an hour old, so a
  release added on the service shows up without a restart.
- the window re-checks the account every ten minutes and when it comes back to the front (at most
  once a minute), and `GET /api/account?force=1` waits up to six seconds for the service's answer,
  so a new role or a donation shows without a restart and *check again* really checks.
- the search pre-flights every card: `GET /api/search` asks `/v1/verdicts` once for the
  whole page, so a title with no keys says *not available* before the click instead of after
  it. A title that is writable but incomplete says nothing about it and keeps its add button: it
  still goes into Steam, which is what matters to the person adding it. The service's own reason (depot counts) stays in its logs; the window
  never prints it. The panel asks `GET /api/verdict` for its own title, so a
  panel opened from the library or a deep link carries the same sentence.
  `POST /api/add` still writes what it is asked to write: the engine answers with `renderable` and
  says so in the toast rather than refusing silently.
- what other machines hit is drawn, not just counted: `/v1/verdicts` and `/v1/package` carry the
  service's `report` for a title, so a row and the panel say *Didn't work for other people 2 of 5
  times*. The status bar does not repeat it.
- `api.warm()` also asks `/v1/latest` once at boot and keeps the answer for twelve hours. The
  Settings row is always there - *You have the latest version* included - with the moment it was
  checked and a **Check** button that skips the cache (`POST /api/update-check`). When a newer build
  is published the row becomes the version, one line of notes and a button. In the window that
  button is **Update now**: the engine downloads the release, checks it against the `sha256` in the
  signed reply (`POST /api/update`, polled with `GET /api/update`), unpacks it into
  `out/update/stage`, and the shell starts `src/update-apply.js` and closes. That script waits for
  the window, copies the staged build over this folder, keeps the parts of `config/steam.json` that
  belong to the person (the Steam root, the overrides), and opens the new build. Each file it replaces
  is moved into `out/update/backup` first; if one cannot be replaced because another program holds it
  open, the copy is undone, the old build opens again and the staged release waits for another try,
  all written to `out/update/last.log`. A browser tab gets
  the older button - it opens the published url - because a tab that promised a restart would lie.
  A release with no checksum is refused before a byte is fetched, and a download that does not match
  is deleted rather than unpacked.
- The row also covers the case a manifest cannot: the server's floor (`min_app_version`), reported as
  `update_required` on the identity reply while every data route answers `426` until the build is
  replaced, `/v1/me` and `/v1/latest` excepted. The row says *this build is too old* and names the
  floor; it does not invent a download address of its own. Every call says which build it is
  (`x-stm-app`), because a build updated in place keeps its `device.json` and never enrolls again -
  judged by that row alone, the machine that had just been fixed would be locked out.
- The window also draws the service's kill switch as its own screen: *SteaMar is off right now*, the
  operator's sentence, and a check-again button. It is not the month's pause - there is no meter and
  nothing to donate - and it says plainly that nothing on the PC is broken.
- A paused month has two screens. Paused because the month is short of money: the meter, the owner's
  note if there is one, and **Donate**. Paused by hand from the console: only the owner's sentence and
  **Check again** - no meter and no Donate button, because money would not switch it back on.
- `GET /api/settings` → `data.api` says whether the app is enrolled, against which server, and what
  the last error was. `GET /api/selftest` checks it in one row.


### Pointing a build at a server

Two fields in `config/steam.json`, and nothing else:

```json
"api": {
  "base": "http://127.0.0.1:8791",
  "public_key": "MCowBQYDK2VwAyEA…"
}
```

`base` is where the service answers; `public_key` is its pinned Ed25519 key, which the service prints
when its key is made. A build handed to other people points `base` at the public host and pins *that* box's
key. Both change together in the release that rotates the key — a pin that lags the server is every
call refused.

Two environment variables override both, for a developer running a server on the same machine:

```
STEAMAR_API=http://127.0.0.1:8791
STEAMAR_API_KEY=<the public half>
```

`STEAMAR_OUT` moves `out/` somewhere else, which is how `test/api.test.js` runs against a throwaway
identity instead of the one on this machine.

There is no fallback past these: an empty `public_key` means no reply can be trusted, and the app says
so rather than half-working. `npm run doctor` names the same thing in one row, and `GET /api/settings`
→ `data.api` carries `configured`, `base`, `enrolled`, `last_ok` and `last_error`.

`last_ok` is the last reply the app *verified*, not the last time it read its own mirror: a cached
answer is not contact with the service, and the settings page would be lying if it counted one.

`node tools/probe-offline.js` starts a throwaway engine pointed at a port nobody listens on and asks
for a fix link: the answer must be `503` with `{"code":"unreachable"}`, which is what makes the window
say *the service is not answering* instead of blaming the release.

## How many games

The status bar quotes a counted total: **88,565 games available**, from `GET /v1/reach` → `addable`.

| part | count | how it is known |
|---|---|---|
| titles in the index, with a key for at least one depot | **86,516** | `supplier_titles` / `supplier_keyed` |
| token-only apps the index never listed | **2,049** | `addable` − `supplier_keyed` |
| **total** | **88,565** | `GET /v1/reach` |

The count is a count, never a sample: the service walks its own tables and answers once. What it does
not count is what it cannot hand over — an app whose depots have no key anywhere is not addable and is
not in the number. Cyberpunk 2077, for example, resolves 13 windows depots with 12 keys and no token.

Nothing about a title is decided in this folder any more: Settings → Library → *What can be added*
shows the keys, the tokens and the title count as the service reports them.

Scripts with no `addappid` at all are config scripts and stay out of the grid.

## Lua dialect

`addappid(id)`, `addappid(id, flag, "key")`, `addtoken(id, "digits")`, `setManifestid(id, "mid"[, size])`, `seteticketurl("url")`, `setStat(id, "steamid")`. Trailing `-- comments` are stripped before parsing; any other well-formed call is accepted and reported as `other`.

## Contributing

Plain CommonJS, no dependencies, and no build step for the engine or the page. Before a pull request,
run `npm test`, `npm run check:ui` and `npm run check:views`; CI runs the same three on every push to
the public repository. A change to `native/` also needs `npm run build:app` and `npm run smoke:app`,
which no test does for you. Comments say why the code is the way it is, not what a line does. One
change per pull request.
