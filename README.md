<!-- this file is automatiicly generated do not edit -->
# TB Tools - Thunderbird CLI Tools
Simplify tasks related to developing thunderbird.

Right now these are only things that i have personally used and found useful but happy to add more.
## Instalation
`npm install -g https://github.com/arschmitz/tb-tools`
## Configuration
TB Tools uses a configuration `.tb.json` file in your users home directory to enable some features.
This file currently contains credentials for phabricator, and bugzilla. Option defaults and other features may be added in the future.
### Sample Configuration
```json
{
  "phabricator": {
    "user": "arschmitz",
    "token": "cli-uxdexxxkzvy5m5j7xxgajqunxjhe"
  },
  "bugzilla": {
    "user": "arschmitz",
    "apiKey": "36IrYQ06NddTOnnp4IBwpZjROxxxmvvuqUcv1M2v"
  }
}
```

## Command List
##### <ins>Quick Links</ins>
- [amend](#amend)
- [comment](#comment)
- [commit](#commit)
- [create](#create)
- [build-rebase](#build-rebase)
- [build-update](#build-update)
- [bump](#bump)
- [help](#help)
- [land](#land)
- [lint](#lint)
- [rebase](#rebase)
- [run](#run)
- [rust-check](#rust-check)
- [run-rebase](#run-rebase)
- [run-update](#run-update)
- [submit](#submit)
- [test](#test)
- [try](#try)
- [update](#update)

## Example Development Workflow

1. Start work on a new bug run `tb create` and follow prompt
2. Build and open thunderbird `tb run`
3. Make changes until ready to commit
4. run lint `tb lint`
5. run tests based on your changes `tb test`
6. Commit changes `tb commit` and follow prompt to generate commit message.
7. Make more changes
8. Add changes to your commit `tb amend` selcting new files to add
9. When ready to submit patches to phabricator lint changes, run tests based on changes, push a try run and submit unsubmited comments in phabricator `tb submit`

## Sheriff Duty

The land command is your all in one tool for handling pushes in thunderbird. This command integrates with both bugzilla and phabricator to form an all in one solution. Just run the land command and tb-tools will check for rust changes and any accompanying patches. Then pulls all bugs marked for checkin and guide you through the process of landing them 1 at a time including viewing and updating the associated bugs and patches. If run with sanity enabled it will run linting and a build at the end before pushing to comm-central. For detailed workflow and documentation see the land command below.

### amend
---
Amends the current commit optionally adding new files
```bash
tb amend
```
<br/><br/>
![Screen recording of amend.](/images/amend.gif)
#### Options
|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|
|----|-----------|--|--|---|
|--addRemove|-a|Add or remove files added or deleted|undefined|`tb amend --addRemove=undefined`

<br/><br/>
### comment
---
Post a comment to phabricator for current patch
```bash
tb comment
```
#### Options
|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|
|----|-----------|--|--|---|
|--message|-m|Comment text to post to phabricator|undefined|`tb comment --message=undefined`
|--resolve|-r|Submit all inline comments and comments marked done|true|`tb comment --resolve=true`

<br/><br/>
### commit
---
Create a new commit with message based on your current bookmark.
```bash
tb commit
```
<br/><br/>
![Screen recording of commit.](/images/commit.gif)

<br/><br/>
### create
---
**Setup to work on a new bug**
1. A new bookmark is created based on a bugzilla bug number `Bug-XXXXXXX`.
2. Optionally update to latest M-C and C-C.
3. Mark the bug `Assigned` and assignee to yourself.
```bash
tb create
```
<br/><br/>
![Screen recording of create.](/images/create.gif)
#### Options
|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|
|----|-----------|--|--|---|
|--update|-u|Update code before creating bookmark|true|`tb create --update=true`

<br/><br/>
### build-rebase
---
the same as rebase but builds when completed alias for `tb rebase -b`
```bash
tb build-rebase
```

<br/><br/>
### build-update
---
the same as update but builds when completed alias for `tb update -b`
```bash
tb build-update
```

<br/><br/>
### bump
---
**Bump thunderbird build Modifying the dummy file**
1. Checks if rust updates are required and if so if patches are available.
2. Updates Mozilla-central and comm-central
3. Updates the dummy file adding or removing a `.`,
4. Commits with the message `No bug, trigger build.`,
5. Outputs the staged commits for approval",
   * Approve - The stack is pushed to comm-central
   * Cancel - The current state is pruned

```bash
tb bump
```
<br/><br/>
![Screen recording of bump.](/images/bump.gif)

<br/><br/>
### help
---
Show help
```bash
tb help
```

<br/><br/>
### land
---
**An interactive cli for sherifing and landing bugs on comm central.**
1. Checks if rust updates are required and if so if patches are available.
2. Updates mozilla-central and comm-central
3. Pulls bugs  marked for checkin and associated patches from bugzilla
   * If no bugs are found prompt to bump dummy file
4. Prompts with a list of patches is displayed
   * Displays a list of actions of the patch upon selection.
     - Open bug in default browser
     - Open Patch in default browser
     - Merge Patch
       + If successful - Commit message is updated with individual reviewers removing groups.
       + If failed  **EXPIRAMENTAL** -
         * A comment is left asking for it to be rebased
         * checkin-needed-tb is removed
         * A comment is left on phabricator asking for a rebase
         * The patch is rolled back
         * The patch selection is shown again with patch removed
     - Skip
       + The patch is skipped removed from the list
       + Patch selection is displayed
5. Patch selection continues until the stack is aborted or continue is selected
6. Run optional sanity checks
   * Run lint
   * Run Build
7. The stack is displayed for approval
8. Upon approved the stack is pushed to comm-central
9. The bug is updated **EXPIRAMENTAL**
   * The milestone is set

```bash
tb land
```
<br/><br/>
![Screen recording of land.](/images/land.gif)

<br/><br/>
### lint
---
run commlint on all files
```bash
tb lint
```
<br/><br/>
![Screen recording of lint.](/images/lint.gif)

<br/><br/>
### rebase
---
**Rebase your current state**
1. Stashes any uncommited change
2. Checks for rust updates with option to abort
3. Updates M-C and C-C
4. Rebase your current stack
4. Uunstashes any uncommited changes
```bash
tb rebase
```
<br/><br/>
![Screen recording of rebase.](/images/rebase.gif)
#### Options
|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|
|----|-----------|--|--|---|
|--run|-r|build run thunderbird when the update complete|false|`tb rebase --run=false`
|--build|-b|build thunderbird when the update is complete|false|`tb rebase --build=false`
|--force|-f|Continue update despite out of sync rust dependencies|false|`tb rebase --force=false`

<br/><br/>
### run
---
builds and launches thunderbird
```bash
tb run
```

<br/><br/>
### rust-check
---

**Check for rust updates**
1. Creates a checkpoint for M-C
2. Pull changes from M-C
3. Check for required rust updates
   * If updates are required
     1. Pull C-C and see if required changes have already been merged
     2. Check if rust updates are required
     3. If updates are still required check phabricator for patches.
     4. If no patches are found abort

```bash
tb rust-check
```
<br/><br/>
![Screen recording of rust-check.](/images/rust-check.gif)

<br/><br/>
### run-rebase
---
The same as rebase but builds and runs when completed. Alias for `tb rebase -r` or `tb rebase && tb run`
```bash
tb run-rebase
```

<br/><br/>
### run-update
---
The same as update but builds and runs when completed. Alias for `tb update -r` or `tb update && tb run`
```bash
tb run-update
```

<br/><br/>
### submit
---
Submits to phabricator.
Optionally:
* Check for changes
  * Prompt to amend current commit
* Run lint
* Run tests
* Submit a try run and post as a comment on phabricator
* Submit pending inline comments and comments marked as done,

```bash
tb submit
```
#### Options
|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|
|----|-----------|--|--|---|
|--lint|-l|lint before submitting patch|true|`tb submit --lint=true`
|--test|-t|run all tests for any components or files modified before submitting patch|true|`tb submit --test=true`
|--try||Submit a try run and comment with the link|true|`tb submit --try=true`
|--resolve|-r|Submit all inline comments and comments marked done|true|`tb submit --resolve=true`
|--update||Check for update and rebase before submitting|undefined|`tb submit --update=undefined`
|--flavor|-f|Flavor of tests to run `browser\|unit\|all`|all|`tb submit --flavor=all`
|--unit-tests|-u|type of tests to run `mochitest\|xpcshell\|all`|all|`tb submit --unit-tests=all`
|--build-types|-b|build types to run|o|`tb submit --build-types=o`
|--artifact||do an artifact build|true|`tb submit --artifact=true`
|--platform|-p|platforms to run tests on|all|`tb submit --platform=all`
|--comment|-c|Post try link as comment to phab revision|false|`tb submit --comment=false`

<br/><br/>
### test
---
Checks files changed or added and runs all tests for any components modified, and test files changed.
```bash
tb test
```
#### Options
|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|
|----|-----------|--|--|---|
|--flavor|-f|Flavor of tests to run `browser\|unit\|all`|all|`tb test --flavor=all`

<br/><br/>
### try
---
pushes a try run with option to comment on phabricator with link
```bash
tb try
```
#### Options
|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|
|----|-----------|--|--|---|
|--unit-tests|-u|type of tests to run `mochitest\|xpcshell\|all`|all|`tb try --unit-tests=all`
|--build-types|-b|build types to run|o|`tb try --build-types=o`
|--artifact||do an artifact build|true|`tb try --artifact=true`
|--platform|-p|platforms to run tests on|all|`tb try --platform=all`
|--comment|-c|Post try link as comment to phab revision|false|`tb try --comment=false`

<br/><br/>
### update
---
pulls m-c & c-c updates to tip and checks for rust changes
```bash
tb update
```
<br/><br/>
![Screen recording of update.](/images/update.gif)
#### Options
|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|
|----|-----------|--|--|---|
|--run|-r|build run thunderbird when the update complete|false|`tb update --run=false`
|--build|-b|build thunderbird when the update is complete|false|`tb update --build=false`
|--force|-f|Continue update despite out of sync rust dependencies|false|`tb update --force=false`

<br/><br/>
```
                                                              .....
                                                      ..::-------====---:..
                                                   .:---====================:.
                                  ..             ::-====================-:
                                  ===:          :-=-   -===================-:
                                 :====-       .::--=--=====================-::
                                :======-    :::--===========================.
                               -========.  :--===============================.
                             .==========:  -=:..        ..:-==================.
                         :.  ===++++++++-                    :================-
                        .== -+++++++++++.                      :===============.
                        :++-+++++=-++++.                        .===============
                        -+++++++---+++-  ..                  ..  :============++
                        -++++++--===++.   ...             ....   .============++
                        -=++++=-====++:    ...:.        .:..     :===========+++
                        :=++++--=====+=      ..::.    ::...     .============++-
                        .==+++=-======*-      ....::::...      :============+++.
                         -==+*=--======+-....................:-===========++++=
                          ===++--=======++:..............::-=============+++++
                           ===++==========+=:......----------==========++++++.
                            =================+=-:...:================+++++++.
                             -++++=================--::--=========++++++++=
                              .=++++++=========================++++++++++:
                                :=+++++++++===============+++++++++++++:
                                  .-++++++++++++++++++++++++++++++++=.
                                     .-++++++++++++++++++++++++++-:
                                         :-=++++++++++++++++=-:.
                                               ..::::::..
                      
```