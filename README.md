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
### amend
---
Amends the current commit optionally adding new files
```bash
tb amend
```
<br/><br/>
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
<br/><br/>
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
<br/><br/>
### create
---
Setup a new bookmark based on a bugzilla bug. Optionally updates to latest prior. Marks the bug assigned and assignee to yourself.
```bash
tb create
```
<br/><br/>
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
<br/><br/>
### build-update
---
the same as update but builds when completed alias for `tb update -b`
```bash
tb build-update
```
<br/><br/>
<br/><br/>
### bump
---
Bump thunderbird build by modifying the dummy file. This command updates to the current state using `update`, checks for rust changes, updates the dummy file adding or removing a `.`, commits with the message `No bug, trigger build.`, outputs the staged commits to ensure it is just the build trigger, asks you to verify changes, and either pushes or cleans up the changes based on input.
```bash
tb bump
```
<br/><br/>
<br/><br/>
### help
---
Show help
```bash
tb help
```
<br/><br/>
<br/><br/>
### land
---
checks for rust updates, updates to the latest C-C and M-C, pulls bugs from bugzilla with keyword `checkin-needed-tb` and Interactivly land patches, allowing to view the bug or patch, then updates the commit messages to remove group reviewers. Finally confirms the stack and pushes or reverts and cleans up.
```bash
tb land
```
<br/><br/>
<br/><br/>
### lint
---
run commlint on all files
```bash
tb lint
```
<br/><br/>
<br/><br/>
### rebase
---
Stashes any uncommited change, pulls m-c & c-c rebases your current stack and unstashes any uncommited changes
```bash
tb rebase
```
<br/><br/>
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
<br/><br/>
### rust-check
---
Check for upstream rust changes without updating locally
```bash
tb rust-check
```
<br/><br/>
<br/><br/>
### run-rebase
---
the same as rebase but builds and runs when completed. Alias for `tb rebase -r` or `tb rebase && tb run`
```bash
tb run-rebase
```
<br/><br/>
<br/><br/>
### run-update
---
the same as update but builds and runs when completed. Alias for `tb update -r` or `tb update && tb run`
```bash
tb run-update
```
<br/><br/>
<br/><br/>
### submit
---
Submits to phabricator, optionally running lint and related tests first and posting a try run and submitting pending comments after.
```bash
tb submit
```
<br/><br/>
#### Options
|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|
|----|-----------|--|--|---|
|--lint|-l|lint before submitting patch|true|`tb submit --lint=true`
|--test|-t|run all tests for any components or files modified before submitting patch|true|`tb submit --test=true`
|--try||Submit a try run and comment with the link|true|`tb submit --try=true`
|--resolve|-r|Submit all inline comments and comments marked done|true|`tb submit --resolve=true`
|--update|-u|Check for update and rebase before submitting|undefined|`tb submit --update=undefined`
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
<br/><br/>
#### Options
|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|
|----|-----------|--|--|---|
|--flavor|-f|Flavor of tests to run `browser\|unit\|all`|all|`tb test --flavor=all`
<br/><br/>
### try
---
pushes a try run
```bash
tb try
```
<br/><br/>
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
![Screen recording of update.](/images/update.gif)
<br/><br/>
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