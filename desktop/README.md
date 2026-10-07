# Desktop host

Run `tb desktop` from comm, or `tb desktop --comm=/path/to/firefox/comm`.
The app starts in its own process and returns the terminal prompt.

`main.cjs` starts the existing console server on loopback and keeps it alive when
its window closes. The console shows one comm repository and its Firefox parent.
External links open as tabs inside the main window. Browser tabs sit beside Tree, Dashboard, and Meta Boards. Back, Forward, and
Reload appear below these tabs while a page is open. Native window
controls close, minimize, or maximize the window. Each external tab has a close
button. Right-click any tab for Open in Browser.
Select Tree, Dashboard, or Meta Boards to return to the console. Pages run in sandboxed `WebContentsView`
instances that share a browser session for sign-in. Normal clicks reuse the most
recently used tab for the same service. A service is one URL origin: its scheme,
host, and port. Right-click any web link in the console or a page to open a new
tab or use the system browser. The Pages menu also controls the active page.
Reload and Cmd/Ctrl+R reload the selected tab, including Console. The console
server and background tasks keep running during a page reload.
Select Commands > Restart, or Restart in the tray menu, to restart the app
and load code changes. Restart uses the normal shutdown and keeps the same
checkout and launch arguments.
The Edit menu supplies the normal copy, paste, cut, undo, and select-all shortcuts.
Right-click selected text to copy it. Right-click a text field to use its editing
commands. These commands work in Console and external pages.

Update, Verify, Review, Implement, rebase, Build, Test, Lint, and Try use task
worktrees. A worktree is a separate source directory that shares the repository's
Git history. Each task has its own paired Firefox and comm directories under
`~/.tb-tools/worktrees` and branches under `tb-task/<task-id>/`. Two tasks can
start from the same commit. Neither task moves the other task's branches or the
author's checkout. Task branches appear in the shared repository graph. There
is no permanent Review checkout and no Working-to-Review sync. Direct author
actions such as Checkout and Commit still act on the author's source directory.
Both the desktop host and `tb console` use this same model.

Build and Test copy the current tracked and untracked edits into a task without
changing their source. AI tasks prepare a real local build before starting.
Native code changes require a native build. Edited AI candidates build again
before completion. Build failures remain failures, with their command output.
Update and Review sessions retain their worktree path across restarts. Paused
rebases retain their replay plan and pending conflict resolution for Continue.
Task directories remain available for resume and inspection.

Each worktree has private build output. Completed binary snapshots and the
compiler cache live in `~/.tb-tools/build-cache`. `TB_BUILD_CACHE_PATH` can move
this cache. Compatible completed native builds and downloaded artifacts can
warm another worktree, including the author's directory. Configuration files,
generated headers, and writable compiler objects are never shared. A fresh
artifact worktree runs one full `mach build` before `mach build faster`.
When sccache is installed, each worktree uses its own server and source base
path with the common compiler cache. The app disables sccache direct mode because
[version 0.18 can reuse stale headers across worktrees](https://github.com/mozilla/sccache/issues/2863).

The daily build service stores its schedule and state in `~/.tb-tools/daily-build`.
Settings accepts one or more local times. The service fetches both `origin/main`
branches and builds in its own detached worktree. It does not switch the author's
checkout. After success, it publishes the completed installed binaries to the
same shared cache. Failed and incomplete builds are not published.

`mobile-gateway.mjs` listens on loopback and requires a one-time pairing code.
It gives each phone its own session and translates that session's API token to
the desktop console token. Tailscale Serve exposes only this gateway over
private HTTPS. The desktop console server is never exposed to the network.
Pairing, actions, revocation, and the proxy have focused tests. A real cellular
test needs Tailscale signed in on the computer and phone.

Run `npm run desktop:package` before `npm run desktop:smoke -- /path/to/comm`.
The smoke test uses private temporary app data. Its window appears briefly for
native keyboard checks and stays hidden for the other checks. It checks
tab opening, tab reuse, Back, Forward, Reload, close, clipboard commands, right-click menu wiring, native
window controls, and tray persistence. Run `npm run desktop:package:all` to
build macOS arm64, Windows x64, and Linux x64 bundles from one checkout. You can
also pass targets such as `win32:arm64` or `linux:arm64` to
`npm run desktop:package -- <target>`. Run the smoke test on each target system
before distribution. Packages are not signed or notarized.

`npm run desktop:worktree:smoke -- /path/to/comm` creates two real task worktrees,
builds each, runs `test_mailServices.js` in each, and checks that the author's
HEAD, status, and unmerged index remain unchanged. `desktop:cache:smoke` checks
compiler-cache hits across the two source paths and verifies that a changed
header causes a new compile. Windows Mach commands use Python; Unix commands
run the executable Mach script. These probes validate the current host. Building
a Windows or Linux package does not replace running its smoke tests on that OS.
