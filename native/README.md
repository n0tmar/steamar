# SteaMar — native shell

The shipped product is a Windows app, not a browser tab: `SteaMar.exe` opens one window, loads
the UI from `ui/` through a WebView2 virtual host, and answers every API call itself. No port,
no localhost page, no address bar.

```
native/
  CMakeLists.txt
  assets/steamar.ico  generated from ../logo.png by tools/make-icon.ps1 - never edited by hand
  src/app.cpp      window, WebView2, message bridge, single instance, --shot
  src/core.cpp     strings, files, project root, log
  src/config.cpp   config/steam.json, registry, Steam process, stplug-in scan
  src/api.cpp      route table: native handlers first, engine fallback second
  src/net.cpp      WinHTTP (only until the catalogue is ported)
  src/json.h       small JSON reader/writer
  src/steamar.rc   icon resource 1, version block
```

## Build

```
cmake -S native -B native/build -G "Visual Studio 17 2022" -A x64
cmake --build native/build --config Release
native\build\Release\SteaMar.exe
```

or `npm run build:app`, then `npm run app`.

Needs the WebView2 SDK (already in your NuGet cache under
`%USERPROFILE%\.nuget\packages\microsoft.web.webview2\1.0.3405.78`) and the WebView2 Runtime,
which ships with Windows 11. Override the SDK with `-DWEBVIEW2_ROOT=<path>`.

The build copies `ui/` next to the exe, so a copied folder runs on its own.

The engine is started from `<folder>\runtime\node.exe` when that file exists — that is what
`npm run portable` stages, so the app runs on a PC without Node — and from `PATH` otherwise.
`STEAMAR_ENGINE` still wins over both.

The window and the exe share one icon: `logo.png` at the project root goes through
`npm run icon` into a seven-frame `.ico` (16-64 DIB, 128 and 256 PNG), `src/steamar.rc` embeds it
as resource 1, and `load_icon()` in `app.cpp` pulls the small and large frames at the size the
current DPI asks for. Replace the artwork and rerun `npm run icon`; nothing else refers to it.

## How the UI talks to the app

| Traffic | Path |
|---|---|
| `index.html`, the `*.js` scripts, the `*.css` sheets | WebView2 virtual host `https://steamar.cc` mapped to `ui/`, served from disk by the browser process |
| `/api/*` | `window.chrome.webview.postMessage({id, path, method, body})`, answered on a worker thread and posted back — no HTTP server in the middle |
| `/img/*` | absolute urls returned by the API, still fetched from the engine's loopback origin until artwork is ported |

`ui/shell.js` picks the transport once: a bridge when it runs inside the shell, `fetch` when the
same files are opened at `127.0.0.1:8788`. Nothing else in the UI knows the difference.

## What is already native

- `GET /api/status` — Steam root, Steam process (process snapshot, no `tasklist` spawn), proxy
  files present, TOML present, library counts, `games available` from `appaccesstokens.json`.
- `POST /api/pick-folder` — `IFileOpenDialog`; the panel is the window's child, so it cannot open
  behind the app.
- `POST /api/reveal` — Explorer on steam / stplug-in / depotcache / out / project.
- `POST /api/install` — `steam://install/<appid>` through ShellExecute.
- `POST /api/cache/clear` — deletes `out/cache` and `out/imgcache`.
- `POST /api/log` — a UI warning or error appended to `out/native.log`.
- `POST /api/text-size` — `put_ZoomFactor` on the controller, 100 to 130 percent, stored in
  `out/window.ini` and applied before the first navigation.
- Window: fixed 1180x760 in logical pixels, no thick frame, no maximise box, and min/max track
  sizes pinned so snap and Win+arrow cannot resize it either; position remembered
  (`out/window.ini`), single instance, dark frame and page background so there is no white flash.

## Starting the engine

The engine stays a Node process for now, and a portable copy carries its own runtime, so the
machine the folder lands on needs nothing installed.

- `runtime\node.exe` beside the exe is used when it exists, otherwise `node` from `PATH`;
  `STEAMAR_ENGINE` overrides both. The child goes into a job object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so closing the window never leaves an orphan.
- Before spawning, the shell asks `http://127.0.0.1:8788/api/status` whether an engine is already
  there. It only reuses one whose `root` is this copy: any listener would answer the port, and a
  second SteaMar (another folder, or one on a stick) would then set up the *first* copy's Steam
  folder while showing it as its own. A mismatch says so and closes the window.
- It first checks with a plain socket whether anything listens on the port at all. An HTTP call to a
  closed loopback port waits about two seconds while Windows retries it, and nothing listening is
  the usual start; with SYN retries switched off the socket answers at once.
- The probe runs on the UI thread before the webview exists, deliberately: `PostQuitMessage` from
  the engine thread queues a quit the message loop never reads, so a conflict has to be decided
  before the loop starts.
- No WebView2 runtime means no page. The shell asks whether to open Microsoft's installer instead
  of dying on a blank frame; that is the one dependency it cannot download itself.

## Text size

`ICoreWebView2Controller` is apartment-threaded: calling `put_ZoomFactor` from the bridge worker
returns `0x802A000C` and changes nothing, silently. So the route does not touch the controller —
it posts `kZoom` to the window with a `ZoomRequest` and waits on an event, the same shape as the
confirm handshake:

```
bridge worker                        UI thread
  api::text_size()                     window_proc(kZoom)
    zoom_blocking(percent) ──post──►     apply_zoom()
    WaitForSingleObject ◄────SetEvent──    put_ZoomFactor, save, log
    return applied percent  ◄──────────────
```

The stored value is read at startup and handed to the controller right after the bounds, before
the first navigation, so the window opens already at the chosen size instead of jumping. Values
outside 100-130 are clamped, not rejected, and every change is logged as `zoom: 130% hr 0` — that
HRESULT is what caught the threading bug.

Everything else is forwarded to the engine (`src/server.js`) which the app starts itself and
keeps in a job object, so it dies with the window. That engine is a stepping stone: each route
moves into `api.cpp` without the UI noticing.

## Dialogs and errors

Dialogs belong to the page: `ui/dialogs.js` draws them in the app's own surfaces, answers Enter and
Escape, traps focus and makes the page `inert`, so there is no second look and no second owner.
The shell used to host a `MessageBoxW` behind `/api/confirm`; that route, its handler and the
window message are gone. A confirm that is drawn by the page cannot open behind the window, cannot
be left behind by a crash, and cannot disagree with the UI about its wording.

What stays in Win32 is failure handling the page cannot do for itself:

- The WebView2 runtime is missing → a message box, because there is no page to draw anything, then
  the offer to open Microsoft's installer.
- A second copy is running on the same port → a message box before the webview exists, then exit.
- Every API route answers JSON, never an exception: `bad_alloc`, `std::exception` and `...` each
  get a status, a message and a `api:` line in `out/native.log`.
- `SetUnhandledExceptionFilter` writes `crash: code 0x… at 0x…` before Windows Error Reporting runs.

## Games source

The catalogue is not hard-coded: `config/steam.json` points at the data repo (`data.manifesthub3`
→ `ManifestHub3/`), the mirror (`data.manifesthub`), and the git remotes under `repos`. Today the
app reads `ManifestHub3/archive/depotkeys.json` and `appaccesstokens.json` straight from disk and
asks `api.steamcmd.net` for a title's depots. When your own repo and API exist, both edges are one
place each: `data.*` for the files, `catalog.resolve_package` for the remote answer. The UI, the
bridge and every native route stay untouched.

## Next ports

1. `GET /api/library` — needs the catalogue's `resolve_display`, so it lands with the names cache.
2. `GET /api/settings`, `GET/POST /api/setup*` — paths are done in `config.cpp`; the rest is file
   copying and a depot-key count.
3. `GET /api/store`, `GET /api/search`, `GET /api/names` — WinHTTP + `json.h` + the on-disk name
   cache; needs a native artwork fetcher to serve `/img/*` too.
4. `POST /api/add` — the last one: appinfo, depot keys, tokens, Lua render and validate.
5. Brand DLLs — `proxy_dlls` in `config/steam.json` is the only place a DLL name appears, so a
   renamed build needs no code change.

## Debug switches

```
SteaMar.exe --root <dir>        # use another project root (config, ui, out)
SteaMar.exe --port 8799         # talk to an engine on another port
SteaMar.exe --shot out/x.png --route settings --wait 1500 --size 1440x900
SteaMar.exe --devtools          # keep devtools and open a CDP endpoint on 9222
```

`--size` only exists for screenshots: the shipped window is fixed at 1180x760 and cannot be
dragged to another size.

`--shot` navigates, waits, writes a PNG of the page through `CapturePreview` and exits — that is
how the UI is checked without a person at the keyboard. `--devtools` is the other half: the
window stays open and answers Chrome DevTools Protocol on `127.0.0.1:9222`, which is what
`tools/verify-app.js` drives. Both are off by default, so a shipped window has no inspector and
no remote debugging port. `out/native.log` records startup timings (root, engine start,
navigation, first API call), the shot, every confirmation, every UI error and any crash.
