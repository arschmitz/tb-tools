# TB Tools - Thunderbird CLI Tools
Simplify tasks related to developing thunderbird.

Right now these are only things that i have personally used and found useful but happy to add more.
## Instalation
`npm install -g https://github.com/arschmitz/tb-tools`
## Command List
##### <ins>Quick Links</ins>
- [bump](#bump)
- [lint](#lint)
- [rebase](#rebase)
- [build-rebase](#build-rebase)
- [run-rebase](#run-rebase)
- [update](#update)
- [build-update](#build-update)
- [run-update](#run-update)
- [test](#test)
- [submit](#submit)
- [try](#try)
- [run](#run)
- [land](#land)
- [help](#help)
### bump
---
Bump thunderbird build by modifying the dummy file. This command updates to the current state using `update`, checks for rust changes, updates the dummy file adding or removing a `.`, commits with the message `No bug, trigger build.`, outputs the staged commits to ensure it is just the build trigger, asks you to verify changes, and either pushes or cleans up the changes based on input.
```bash
tb bump
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
### build-rebase
---
the same as rebase but builds when completed alias for `tb rebase -b`
```bash
tb build-rebase
```
### run-rebase
---
the same as rebase but builds and runs when completed. Alias for `tb rebase -r` or `tb rebase && tb run`
```bash
tb run-rebase
```
### update
---
pulls m-c & c-c updates to tip and checks for rust changes
```bash
tb update
```
#### Options
|option&nbsp;&nbsp;&nbsp;&nbsp;|alias|Description|Default|
|----|-----------|--|--|
|run|r|build run thunderbird when the update complete|false|
|build|b|build thunderbird when the update is complete|false|
### build-update
---
the same as update but builds when completed alias for `tb update -b`
```bash
tb build-update
```
### run-update
---
the same as update but builds and runs when completed. Alias for `tb update -r` or `tb update && tb run`
```bash
tb run-update
```
### test
---
Checks files changed or added and runs all tests for any components modified, and test files changed.
```bash
tb test
```
#### Options
|option&nbsp;&nbsp;&nbsp;&nbsp;|alias|Description|Default|
|----|-----------|--|--|
|flavor|f|Flavor of tests to run `browser|unit|all`|all|
### submit
---
lints all files and submits to phabricator
```bash
tb submit
```
#### Options
|option&nbsp;&nbsp;&nbsp;&nbsp;|alias|Description|Default|
|----|-----------|--|--|
|lint|l|lint before submitting patch|true|
|test|t|run all tests for any components or files modified before submitting patch|true|
|flavor|f|Flavor of tests to run `browser|unit|all`|all|
### try
---
pushes a try run
```bash
tb try
```
#### Options
|option&nbsp;&nbsp;&nbsp;&nbsp;|alias|Description|Default|
|----|-----------|--|--|
|unit-tests|u|type of tests to run `mochitest|xpcshell|all`|all|
|build-types|b|build types to run|o|
|artifact||do an artifact build|true|
|platform|p|platforms to run tests on|all|
### run
---
builds and launches thunderbird
```bash
tb run
```
### land
---
updates to the latest C-C and M-C then Interactivly land patches, updating the commit messages to remove group reviewers. Finally confirms the stack and pushes or reverts and cleans up.
```bash
tb land
```
### help
---
Show help
```bash
tb help
```
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