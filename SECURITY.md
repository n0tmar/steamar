# Security

SteaMar runs a local engine on 127.0.0.1, writes into the Steam folder, and installs the updates it
downloads. A mistake in any of those can hurt the person running it, so a report is welcome.

Report a problem privately: use **Report a vulnerability** on this repository's Security tab, or write
to the owner on [Discord](https://discord.gg/UkdAQ8q8Et). Please do not open a public issue for it.
Say what you did, what happened, and which version you run.

In scope is the code in this repository: the engine in `src/`, the page in `ui/`, the window in
`native/`, the installer script, and the update path (`src/update.js`, `src/update-apply.js`). The
helper DLLs are not: they are third-party, downloaded at setup and pinned in `vendor/vendor.json`, so
report problems in them to their authors. The service the app talks to is not in this repository, but
a problem with it is welcome through the same channels.

A fix ships in the next release, and the app offers that release to everyone through its updater.
