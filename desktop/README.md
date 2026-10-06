# Desktop host

`main.cjs` starts the existing console server on loopback and keeps it alive when
its window closes. It creates a Review worktree pair before loading the console.
External links open as tabs inside the main window. A fixed header keeps Back,
Forward, Reload, Close tab, and the tab list visible while a page is open.
The console stays in its own tab. Pages run in sandboxed `WebContentsView`
instances that share a browser session for sign-in. Right-click any web link in
the console or a page to open it in the system browser. The Pages menu also
controls the active page.

The daily build service stores its schedule and state in `~/.tb-tools/daily-build`.
It fetches both `origin/main` branches and builds in its own detached worktree.
It does not switch the Working checkout. Each worktree has a private object
directory. Completed artifact snapshots are shared. sccache stores compiler
results in one cache when installed, but cross-worktree hits depend on the
active server's base paths. The app disables sccache direct mode because
[version 0.18 can reuse stale headers across worktrees](https://github.com/mozilla/sccache/issues/2863).

`mobile-gateway.mjs` listens on loopback and requires a one-time pairing code.
It gives each phone its own session and translates that session's API token to
the desktop console token. Tailscale Serve exposes only this gateway over
private HTTPS. The desktop console server is never exposed to the network.
Pairing, actions, revocation, and the proxy have focused tests. A real cellular
test needs Tailscale signed in on the computer and phone.

Run `npm run desktop:package` before `npm run desktop:smoke -- /path/to/comm`.
The smoke test hides its window and uses private temporary app data. It checks
tab opening, tab reuse, Back, Forward, close, right-click menu wiring, native
window controls, and tray persistence. Run `npm run desktop:package:all` to
build macOS arm64, Windows x64, and Linux x64 bundles from one checkout. You can
also pass targets such as `win32:arm64` or `linux:arm64` to
`npm run desktop:package -- <target>`. Run the smoke test on each target system
before distribution. Packages are not signed or notarized.
