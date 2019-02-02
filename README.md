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

Configuration
-------------

mozblocklist does not need any configuration, unless you use one of the features that require access
to redash or bugzilla. This is for example if you use `mozblocklist check -i` to retrieve the guids
for ids from redash, or if you want to have bugs automatically marked as fixed when using
`mozblocklist sign`.

If you make use of [pyamo](https://github.com/kewisch/pyamo) you will already have the redash
config, but may need to add a bugzilla api key.

To create the config, you can add a `~/.amorc` (or `%HOME%/amorc.ini` on Windows). This happens to
be the same file that [pyamo](https://github.com/kewisch/pyamo) uses. You'll need to set your redash
user api key (not the query key) and bugzilla api token in the `[auth]` section:

```
[auth]
redash_key=42c85d86fd212538f4394f47c80fa62c
bugzilla_key=8342c234ff833e8842a492d482eb24
```

Examples
--------

Create a blocklist entry for all add-ons in `baddons`. Empty lines and those prefixed with `#`
will be ignored. You need to have access to the settings writer for this.
```
cat baddons | mozblocklist create
```

Just check if the add-ons are already in the blocklist. Instead of reading from a file, the guids
will be prompted for. This uses the public blocklist host by default. It will also take guids from
stdin like in the example above, if you prefer.
```
mozblocklist check
```

Check for add-ons in the blocklist, if you only have a file with the AMO ids. This requires the
redash API key to be set in the configuration, see above.

```
cat badids | mozblicklist check -i
```

Get the current state of the blocklist (signed, work in progress, in review), on the staging instance.
```
mozblocklist -H settings-writer.stage.mozaws.net status
# or
mozblocklist -s status
```

When asked to review a block, you can sign it using this command. Bugzilla bugs will automatically
be closed and needinfos removed.
```
mozblocklist sign
```
