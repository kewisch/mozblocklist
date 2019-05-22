/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2018-2019 */

export const COMMENT_CHAR = "#";

export const SOFT_BLOCK = 1;
export const HARD_BLOCK = 3;

export const STAGE_HOST = "settings-writer.stage.mozaws.net";
export const PROD_HOST = "settings-writer.prod.mozaws.net";
export const PUBLIC_HOST = "firefox.settings.services.mozilla.com";

export const REDASH_URL = "https://sql.telemetry.mozilla.org/";

// If you ever need to redo the data source id:
// let sources = await redash.getDataSources();
// let amodb = sources.find(source => source.name == "AMO-DB");
export const REDASH_AMO_DB = 25;
