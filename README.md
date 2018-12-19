mozblocklistcheck
=================

This simple and hacked up tool retrieves the blocklist from kinto, tells you which of the guids you
provided are already blocked, and creates the regex for use in kinto to initiate a new block

Installation and Usage
----------------------
This module is not on npmjs yet. To install, you can run `npm install -g .` in the cloned directory,
or `npm link` in case you want to make changes to the sources.

The program will load the blocklist and then takes guid entries from stdin. You can either pipe in a
file, or you can enter them manually.
