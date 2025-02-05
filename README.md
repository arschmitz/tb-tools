
# Thunderbird CLI
Simplify tasks related to developing thunderbird

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
