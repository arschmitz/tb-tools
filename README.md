
# Thunderbird CLI Tools
Simplify tasks related to developing thunderbird

## Instalation
`npm install -g https://github.com/arschmitz/tb-tools`

## Examples
```
  $ tb update
  $ tb bump
```

## Command List

|Command&nbsp;&nbsp;&nbsp;&nbsp;|Description|
|----|-----------|
|help| Show help |
|bump|Bump thunderbird build by modifying the dummy file. This command updates to the current state using `update`, checks for rust changes, updates the dummy file adding or removing a `.`, commits with the message `No bug, trigger build.`, outputs the staged commits to ensure it is just the build trigger, asks you to verify changes, and either pushes or cleans up the changes based on input.|
|lint|run commlint on all files|
|rebase|Stashes any uncommited change, pulls m-c & c-c rebases your current stack and unstashes any uncommited changes|
|update|pulls m-c & c-c updates to tip and checks for rust changes|
|build-update|the same as update but builds when completed|
|go|goes to the comm folder if location is configured in settings|
|submit|lints all files and submits to phabricator|
|try|pushes a try run|
|run|builds and launches thunderbird|
|land|updates to the latest C-C and M-C then Interactivly land patches, updating the commit messages to remove group reviewers. Finally confirms the stack and pushes or reverts and cleans up.|

### Try Options
Valid options for the `try` command
|option&nbsp;&nbsp;&nbsp;&nbsp;|alias|Description|Default|
|----|-----------|--|--|
|unit-tests|u|run unit tests|mochitest|
|build-types|b|build types to run|o|
|artifact||do an artifact build|true|
|platform|p|platforms to run tests on|all|
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
