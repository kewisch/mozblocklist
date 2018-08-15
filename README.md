mozblocklistcheck
=================

This simple and hacked up tool retrieves the blocklist from kinto, tells you which of the guids you provided are already blocked, and creates the regex for use in kinto to initiate a new block

Installation and Usage
----------------------
Currently this package is just set up to run from the git directory it was cloned to. To get started, run `npm i` to install dependencies.

To run, execute `node index.js`. The program will load the blocklist and then takes guid entries from stdin. You can either pipe in a file, or you can enter them manually.

⚠️ Due to [a bug](https://github.com/Kinto/kinto-http.js/issues/292), kinto-http doesn't work out of the box. You can work around by running `npm i node-fetch`. Afterwards, open `node_modules/kinto-http/lib/http.js` and add `var fetch = require("node-fetch");` to the top.
