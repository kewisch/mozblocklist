mozblocklist
============

This simple and hacked up tool retrieves the blocklist from kinto, tells you which of the guids you
provided are already blocked, and creates the regex for use in kinto to initiate a new block

Installation
------------
This module is not on npmjs yet. To install, you can run `npm install -g .` in the cloned directory,
or `npm link` in case you want to make changes to the sources.

The program will load the blocklist and then takes guid entries from stdin. You can either pipe in a
file, or you can enter them manually.

Examples
--------

Create a blocklist entry for all add-ons in `baddons`. Empty lines and those prefixed with `#`
will be ignored. You need to have access to the settings writer for this.
```
cat baddons | mozblocklist create
```

Just check if the add-ons are already in the blocklist. Instead of reading from a file, the guids
will be prompted for. This uses the public blocklist host by default.
```
mozblocklist check
```

Get the current state of the blocklist (signed, work in progress, in review), on the staging instance.
```
mozblocklistcheck -H settings-writer.stage.mozaws.net status
```
