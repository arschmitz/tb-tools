# Desktop host

Run `tb desktop` from comm, or `tb desktop --comm=/path/to/firefox/comm`.
The app starts in its own process and returns the terminal prompt.

On first launch, choose **Use an existing checkout** or **Set up a new environment**.
An existing checkout can be the Thunderbird `comm` folder or its Firefox parent.
The app saves its absolute path in `checkout.json` in the app data directory.
Later launches can start from any directory. `--comm` or `TB_COMM_PATH` overrides
the saved path. If the saved checkout moves, the setup window opens again.

For a new environment, choose a parent folder and a build type, then select
**Set up environment**. Setup creates a new `thunderbird` folder, clones Firefox
from `mozilla-firefox/firefox` and Thunderbird from `thunderbird/thunderbird-desktop`
on GitHub, and writes a Thunderbird `mozconfig`. Full builds support all source
changes. Artifact builds download compiled components and suit JavaScript,
HTML, and CSS changes. Both modes install full desktop bootstrap dependencies,
as required by the [Thunderbird setup guide](https://developer.thunderbird.net/thunderbird-development/building-thunderbird/linux-build-prerequisites).

Setup opens a native terminal for Git, Python, and `mach bootstrap`. Follow its
system and password prompts. Git and Python 3 must already be installed. Windows
also needs MozillaBuild 4 or later at `C:\mozilla-build`, or the location in
`MOZILLABUILD`. Linux needs `x-terminal-emulator`, `gnome-terminal`, or `xterm`.
The setup window links to the official platform prerequisites. Choose a source
path without spaces and allow at least 40 GB of free disk space.

Setup state is saved in `setup.json` beside `checkout.json`. Closing the app
leaves the terminal running. Reopening the app restores setup progress. Retry
reuses completed downloads and reruns a failed bootstrap. An interrupted Git
clone is kept; setup asks for a new location or for the incomplete folder to be
moved before retrying. Setup never deletes or replaces an existing checkout or
build configuration. Select **Continue** after setup succeeds to add service keys.

Both checkout paths end with **Connect Phabricator and Bugzilla**. Enter your
Phabricator username and API token, and your Bugzilla API key. Buttons open the
services' settings pages in your browser. **Save and open dashboard** merges the
keys into `~/.tb.json` before the backend starts. Other settings stay unchanged,
and blank key fields keep existing keys. Keys are masked in the form and stored
as plain text in an owner-only settings file. Existing keys are not sent back
to the form. A damaged settings file must be fixed before keys can be saved.

**Skip for now** opens the dashboard without changing service settings. Setup
remembers this choice for the selected checkout. A configured checkout with
missing keys shows this final step once, unless it was already completed or
skipped. Use Build and Run in the dashboard to compile and launch Thunderbird.

Settings also has a **Phabricator and Bugzilla** section. Use **Save service keys**
to add or replace credentials later. Blank key fields keep saved keys. This section
works even if the AI model list cannot load. Restart the app or console after
saving so all API clients and account-specific stores use the new credentials.

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

The desktop app checks local and fetched Rust dependencies at startup and every
five minutes. If dependencies are out of sync, it fetches Firefox and Thunderbird
`origin/main`. If the new revisions have compatible Rust dependencies, it checks
and builds that exact pair in detached worktrees. After the build passes, it
updates both primary checkouts with fast-forward merges and prepares the primary
checkout build with its existing configuration. Both primary checkouts must stay
clean and on `main`; patch branches, local edits, and diverged history block the
update. Source changes during the worktree build also block the update.

The Rust status tooltip shows update progress and failures. Failed or blocked
updates retry after 30 minutes. Build state, one reusable worktree pair, and the
latest build log are kept under `~/.tb-tools/dependency-update`, in a directory
for each source pair. Pending builds resume on a later check after restarting the
app. If one checkout updates and the next step fails, the status names the updated
checkout; the app keeps that state for retry. Quitting cancels the active build.

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
before distribution. Mac packages have an ad-hoc signature for bundle integrity.
They do not have an Apple Developer ID signature or notarization. Windows packages are unsigned.

`npm run desktop:release` builds a downloadable installer for the current machine:
macOS Apple Silicon (arm64) gets a DMG, Windows x64 gets an EXE installer, and Linux x64
gets an AppImage. Downloads and their SHA-256 checksum files go in
`dist/downloads`. The command first creates the existing package, checks its
bundled native dependencies, then opens the shipped app with a temporary profile
to test the first-run screen. Linux needs a display; use `xvfb-run -a npm run
desktop:release` on a build server. The app includes Node.js. Users do not need
to install Node or clone this tools repository to launch it.

The **Desktop downloads** GitHub Actions workflow runs each build on a standard
GitHub-hosted machine with the same operating system and architecture. You can
control all three builds from a Mac. It runs when a `v*` tag is pushed, or from
**Actions > Desktop downloads > Run workflow** with an existing version tag.
The tag must match the version in `package.json`, such as `v1.0.0` for `1.0.0`.
The workflow must be present on the default branch for the manual button to appear.

The workflow creates a draft release labeled **building**, uploads each tested
download directly to that draft, and marks it **ready for review** only after
all three jobs pass. Failed jobs leave an incomplete draft. Retry the failed jobs,
check all results, then publish the draft from GitHub Releases. Published releases
cannot be replaced by this workflow; use a new version instead. No downloads are
published automatically. The workflow needs repository Actions enabled and its
`GITHUB_TOKEN` needs permission to write releases. No separate token is required.

For this public repository, standard GitHub-hosted build time is free. The workflow
does not retain Actions artifacts or enable an npm cache. Downloads live in
GitHub Releases, which has no total release-size or download-bandwidth limit;
each asset must be smaller than 2 GiB. See
[Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
and [release limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

Mac downloads have an ad-hoc signature for bundle integrity. The release build
verifies the signature before creating the DMG and checks the app inside the final DMG.
The Mac app has no Apple Developer ID signature or notarization. Windows downloads
are unsigned. macOS and Windows may block them or show security prompts. Trusted signing and notarization need a
separate credential setup. Native startup checks cover the setup screen; they
do not download Thunderbird, install its toolchain, or compile Thunderbird.
Intel Mac, Linux ARM64, and Windows ARM64 downloads are not included in this release matrix.

`npm run desktop:worktree:smoke -- /path/to/comm` creates two real task worktrees,
builds each, runs `test_mailServices.js` in each, and checks that the author's
HEAD, status, and unmerged index remain unchanged. `desktop:cache:smoke` checks
compiler-cache hits across the two source paths and verifies that a changed
header causes a new compile. Windows Mach commands use Python; Unix commands
run the executable Mach script. These probes validate the current host. Building
a Windows or Linux package does not replace running its smoke tests on that OS.

First-time contributor setup checks Git, Python 3.10 or newer, and the platform
build tools before preparing source files. New source locations also need at
least 40 GB free. This is a minimum check, not an estimate for every build.
The **Install missing tools** button opens the system installer in a terminal:
Apple command line tools and Homebrew on macOS, MozillaBuild on Windows, or
APT/DNF packages on supported Linux distributions. The user handles password
and installer prompts. Other Linux distributions link to the manual steps.

Both new and existing checkout setup ask for a Git name and email. Setup fills
in missing identities with `git config --local` in Firefox and `comm`. It keeps
existing identities and global Git settings. Existing source files and
`mozconfig` settings are preserved. The active configuration must select
`--enable-project=comm/mail`.

Setup runs `mach bootstrap`, then `mach build` from the Firefox root. It only
marks the environment ready after Thunderbird opens its main window in a new
profile under the app's `development-profiles` directory. A local Marionette
connection checks the profile and Thunderbird window. It does not use or copy
the user's mail profile. Failed launches keep a log in the development profile.
The verified development instance stays open.

After the service-key step, contributors can optionally install and connect
`moz-phab`. Setup uses `mach install-moz-phab`, prompts for authentication, and
uses the read-only `moz-phab list` command to check the account. This connection
is separate from dashboard API keys. It never submits a patch. Contributors
can open the dashboard and set up submission later, including after an
authentication failure.

Windows setup uses the current MozillaBuild installer (version 4 or newer).
The installer requests administrator approval and setup waits for it to finish.
Canceling that prompt or failing installation keeps setup incomplete. The build
runs in the MozillaBuild console so its prompts remain available.

The `Windows initial setup` workflow tests checkout persistence, recovery,
credentials, the setup window, and native batch launch with paths that contain
spaces. Installer checks use simulated results. These tests do not complete
administrator prompts, download source trees, bootstrap a toolchain, or build Thunderbird.
A full first-run check on Windows must still complete those steps and confirm
that Thunderbird opens its main window in the separate development profile.
