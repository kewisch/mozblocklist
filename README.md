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

mozblocklist has a number of configuration options that are not necessary, but make it much more
useful. The configuration file is at `~/.amorc` and is a JSON file. This file is shared with various
other tools around AMO, such as [pyamo](https://github.com/kewisch/pyamo).

### `auth` section
This section contains API keys, for redash and bugzilla:

```json
{
  "auth": {
    "redash_key": "42c85d86fd212538f4394f47c80fa62c",
    "bugzilla_key": "8342c234ff833e8842a492d482eb24"
  }
}
```

### `mozblocklist.reviewers` section
For the `mozblocklist review` feature, you can also configure reviewer aliases as such:

```json
{
  "mozblocklist": {
    "reviewers": {
      "alias1": { "name": "Name", "email": "email@example.com" },
      "alias2": { "name": "Other Name", "email": "email2@example.com" }
    }
  }
}
```

The name will be used in the bugzilla comment, so you will likely pick the reviewer's first name.
The email is the bugzilla email. You can then use `mozblocklist review -r alias1` to ask for review.

### `mozblocklist.defaults` section
Within mozblocklist there is a defaults section, which can be used to configure command line flag
defaults. This is using the
[yargs config object feature](https://github.com/yargs/yargs/blob/master/docs/api.md#configobject).

For example, you could set a default reviewer:

```json
{
  "mozblocklist": {
    "defaults": {
      "reviewer": "alias1"
    }
  }
}
```


Examples
--------

Create a blocklist entry for all add-ons in `baddons`. Empty lines and those prefixed with `#`
will be ignored. You need to have access to the settings writer for this.
```
cat baddons | mozblocklist create
```

Create a blocklist entry for the guids from the given bug. The bug must be using the new blocklist
bug form. Values from the from will be suggested and can be modified if needed.
```
mozblocklist create -B 1540287
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

To ask for review on a block, you can request it with this command. A comment will automatically be
added to bugzilla and the needinfo will be requested. See also the configuration section on how to
set up reviewer aliases.
```
mozblocklist review -r alias1
mozblocklist review -r Name email@example.com
```

When asked to review a block, you can sign it using this command. Bugzilla bugs will automatically
be closed and needinfos removed.
```
mozblocklist sign
```
