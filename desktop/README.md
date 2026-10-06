# Desktop host

`main.cjs` starts the existing console server on loopback and keeps it alive when
its window closes. It creates a Review worktree pair before loading the console.
External links open in `WebContentsView` windows. One window is reused per site.
The Pages menu can reload, navigate, or close these windows.

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
test needs Tailscale signed in on the Mac and phone.

Run `npm run desktop:package` before `npm run desktop:smoke -- /path/to/comm`.
The smoke test hides its windows. It checks page reuse and confirms that the
desktop process remains alive when the console window closes.
