# SteaMar

A Windows app for your Steam library: search for a game, add it, and Steam installs it like any
other game. It also shows what you already have, repairs a broken setup, and updates itself.

Three parts: the engine is plain Node.js in `src/`, the page is in `ui/`, and the window around them
is a small C++ program in `native/`. The service the app talks to is not part of this repository.

## Running it

You need Windows 10 or 11 (64-bit), Steam, and Node 20 or newer:

```
npm start
```

Open http://127.0.0.1:8788 — the same page the window shows. The window itself needs Visual Studio
2022 with the C++ workload, CMake and the WebView2 SDK; [native/README.md](native/README.md) has the
build.

On first start the app downloads three helper DLLs. They are third-party, so they are not in this
repository. `vendor/vendor.json` pins where they come from and their checksums, and the app refuses
any other file.

## Tests

```
npm test
npm run check:ui
npm run check:views
```

None of them need a browser, Steam or the service. A change in `native/` also needs
`npm run build:app`, because no test builds the C++.

## What is where

```
src/      the engine: a local server on 127.0.0.1:8788
ui/       the page, one script per job
native/   the window and the installer script
config/   default settings
test/     tests and recorded fixtures
tools/    check scripts
```

## License

MIT. See [LICENSE](LICENSE). For a security problem, see [SECURITY.md](SECURITY.md) and please do
not open a public issue.
