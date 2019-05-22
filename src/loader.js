#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2019 */

// Inject fetch so that kinto-http can make use of it
global.fetch = require("node-fetch");

require = require("esm")(module); // eslint-disable-line no-native-reassign
module.exports = require("./cli.js");
