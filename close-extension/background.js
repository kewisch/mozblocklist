/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2019 */

browser.tabs.onUpdated.addListener((tabId, { status }, { url }) => {
  if (url && url.match(/^http:\/\/127.0.0.1:\d+\/mozblocklist/) && status == "complete") {
    browser.tabs.remove(tabId);
  }
});
