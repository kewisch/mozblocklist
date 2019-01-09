/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2018 */

module.exports = {
  COMMENT_CHAR: "#",

  HARD_BLOCK: 3,
  SOFT_BLOCK: 1,

  STAGE_HOST: "settings-writer.stage.mozaws.net",
  PROD_HOST: "settings-writer.prod.mozaws.net",
  PUBLIC_HOST: "firefox.settings.services.mozilla.com",

  REDASH_URL: "https://sql.telemetry.mozilla.org/",

  // If you ever need to redo the data source id:
  // let sources = await redash.getDataSources();
  // let amodb = sources.find(source => source.name == "AMO-DB");
  REDASH_AMO_DB: 25
};
