# SteaMar

SteaMar is a Windows app for your Steam library. You search for a game, add it, and Steam installs
it like any other game in your library. It also shows what you already have, fixes a broken setup,
and keeps itself up to date.

This repository is the app. The service it talks to is a separate, private project.

## Getting it

Download the installer from [steamar.cc](https://steamar.cc). It installs for your user only, so
there is no administrator prompt. Windows may warn you the first time, because the installer is not
code-signed yet.

You need Windows 10 or 11 (64-bit) and Steam. The window uses Microsoft Edge WebView2, which Windows
11 already has.

## Building it yourself

The app has two parts. The engine is plain Node.js in `src/`, and the page it shows is in `ui/`.
The window around them is a small C++ program in `native/`.

To work on the engine and the page, you only need Node 20 or newer:

```
npm start
```

Then open http://127.0.0.1:8788 in a browser. It is the same page the window shows.

To build the window you also need Visual Studio 2022 with the C++ workload, CMake, and the WebView2
SDK. `tools/install-cmake-msvc-windows-sdk-and-webview2.ps1` installs all three, and
[native/README.md](native/README.md) explains the build. Then:

```
npm run build:app
npm run app
```

`npm run package` builds the zip the updater uses and the installer (it needs Inno Setup 6).

On first start the app downloads three helper DLLs. They are third-party, so they are not in this
repository; `vendor/vendor.json` pins where they come from and their checksums, and the app refuses
any other file.

## Tests

```
npm test
npm run check:ui
npm run check:views
```

None of them need a browser, Steam, or the service. They run on every push. A change in `native/`
also needs `npm run build:app` and `npm run smoke:app`, because no test builds the C++.

## Layout

```
src/      the engine: a local server on 127.0.0.1:8788 and everything it does
ui/       the page, one script per job, loaded in the order index.html lists
native/   the window (C++, WebView2) and the installer script
config/   default settings
test/     unit tests and recorded fixtures
tools/    build, package and check scripts
docs/     how it works in detail
```

[docs/internals.md](docs/internals.md) goes through the app view by view: how Denuvo games are
handled, what Repair checks, how updates are applied, and the Lua format it writes.

## Contributing

Bug reports and questions are welcome on [Discord](https://discord.gg/UkdAQ8q8Et), and pull requests
here. The code is plain CommonJS with no dependencies and no build step for the engine or the page.
Keep a pull request to one change, and run the tests first. Comments explain why the code is the way
it is, not what a line does.

For a security problem, see [SECURITY.md](SECURITY.md) and please do not open a public issue.

## License

MIT. See [LICENSE](LICENSE).
