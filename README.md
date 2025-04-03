<!-- this file is automatiicly generated do not edit -->
# TB Tools - Thunderbird CLI Tools
Simplify tasks related to developing thunderbird.

Right now these are only things that i have personally used and found useful but happy to add more.
## Instalation
`npm install -g https://github.com/arschmitz/tb-tools`
## Command List
##### <ins>Quick Links</ins>
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
### build-rebase
---
the same as rebase but builds when completed alias for `tb rebase -b`
```bash
tb build-rebase
```
### build-update
---
the same as update but builds when completed alias for `tb update -b`
```bash
tb build-update
```
### bump
---
Bump thunderbird build by modifying the dummy file. This command updates to the current state using `update`, checks for rust changes, updates the dummy file adding or removing a `.`, commits with the message `No bug, trigger build.`, outputs the staged commits to ensure it is just the build trigger, asks you to verify changes, and either pushes or cleans up the changes based on input.
```bash
tb bump
```
### help
---
Show help
```bash
tb help
```
### land
---
updates to the latest C-C and M-C then Interactivly land patches, updating the commit messages to remove group reviewers. Finally confirms the stack and pushes or reverts and cleans up.
```bash
tb land
```
### lint
---
run commlint on all files
```bash
tb lint
```
### rebase
---
Stashes any uncommited change, pulls m-c & c-c rebases your current stack and unstashes any uncommited changes
```bash
tb rebase
```
#### Options
|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|
|----|-----------|--|--|---|
|--run|-r|build run thunderbird when the update complete|false|`tb rebase --run=false`
|--build|-b|build thunderbird when the update is complete|false|`tb rebase --build=false`
### run
---
builds and launches thunderbird
```bash
tb run
```
### rust-check
---
Check for upstream rust changes without updating locally
```bash
tb rust-check
```
### run-rebase
---
the same as rebase but builds and runs when completed. Alias for `tb rebase -r` or `tb rebase && tb run`
```bash
tb run-rebase
```
### run-update
---
the same as update but builds and runs when completed. Alias for `tb update -r` or `tb update && tb run`
```bash
tb run-update
```
### submit
---
Submits to phabricator, optionally running lint and related tests first
```bash
tb submit
```
#### Options
|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|
|----|-----------|--|--|---|
|--lint|-l|lint before submitting patch|true|`tb submit --lint=true`
|--test|-t|run all tests for any components or files modified before submitting patch|true|`tb submit --test=true`
|--try|-|Submit a try run and comment with the link|true|`tb submit --try=true`
|--resolve|-r|Submit all inline comments and comments marked done|true|`tb submit --resolve=true`
|--flavor|-f|Flavor of tests to run `browser\|unit\|all`|all|`tb submit --flavor=all`
|--unit-tests|-u|type of tests to run `mochitest\|xpcshell\|all`|all|`tb submit --unit-tests=all`
|--build-types|-b|build types to run|o|`tb submit --build-types=o`
|--artifact|-|do an artifact build|true|`tb submit --artifact=true`
|--platform|-p|platforms to run tests on|all|`tb submit --platform=all`
|--comment|-c|Post try link as comment to phab revision|false|`tb submit --comment=false`
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
### try
---
pushes a try run
```bash
tb try
```
#### Options
|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|
|----|-----------|--|--|---|
|--unit-tests|-u|type of tests to run `mochitest\|xpcshell\|all`|all|`tb try --unit-tests=all`
|--build-types|-b|build types to run|o|`tb try --build-types=o`
|--artifact|-|do an artifact build|true|`tb try --artifact=true`
|--platform|-p|platforms to run tests on|all|`tb try --platform=all`
|--comment|-c|Post try link as comment to phab revision|false|`tb try --comment=false`
### update
---
pulls m-c & c-c updates to tip and checks for rust changes
```bash
tb update
```
#### Options
|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|
|----|-----------|--|--|---|
|--run|-r|build run thunderbird when the update complete|false|`tb update --run=false`
|--build|-b|build thunderbird when the update is complete|false|`tb update --build=false`
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