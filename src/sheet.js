/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2020 */

import { google } from "googleapis";
import { waitForInput } from "./utils";
import { open } from "openurl";

export class GoogleSheets {
  constructor({ sheetId, credentials, authstore, debug }) {
    this.sheetId = sheetId;
    this.storage = authstore;
    this.debug = debug;

    if (credentials) {
      let { client_secret, client_id, redirect_uris } = credentials;
      this.oauth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
      this.sheets = google.sheets({ version: "v4", auth: this.oauth });
    }
  }

  get enabled() {
    return !!this.oauth;
  }

  async authenticate() {
    let tokendata = await this.storage.get();
    if (tokendata) {
      if (this.debug) {
        console.log("Reading token data from auth storage");
      }
      let tokens = JSON.parse(tokendata);
      this.oauth.setCredentials(tokens);
      return;
    }

    let authUrl = this.oauth.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    console.log(`Opening ${authUrl} in your browser`);
    open(authUrl);
    let code = await waitForInput("Google token (from your browser):", false);
    try {
      let { tokens } = await this.oauth.getToken(code);
      this.oauth.setCredentials(tokens);
      this.storage.set(JSON.stringify(tokens));
    } catch (e) {
      this.storage.remove();
      if (this.debug) {
        console.error("Could not authenticate with Google Sheets:", e);
      }
      throw e;
    }
  }

  async ensureAuth() {
    if (!this.token) {
      await this.authenticate();
    }
  }

  async appendRows(range, rows) {
    await this.ensureAuth();

    return this.sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: range,
      valueInputOption: "USER_ENTERED",
      resource: { values: rows }
    });
  }
}

export class UserSheet extends GoogleSheets {
  constructor({ sheetId, sheetRange, credentials, authstore }) {
    super({ sheetId, credentials, authstore });
    this.sheetRange = sheetRange;
  }

  async appendUserRows(data) {
    return this.appendRows(this.sheetRange, data);
  }
}
