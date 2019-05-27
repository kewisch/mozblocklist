/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2018-2019 */

import KintoClient from "kinto-http";
import querystring from "querystring";
import http from "http";
import { open } from "openurl";
import { URL, parse as urlparse } from "url";
import { HARD_BLOCK } from "./constants";
import { requiresVPN } from "amolib";

/**
 * Blocklisting specific version of the KintoClient
 */
export default class BlocklistKintoClient extends KintoClient {
  /**
   * Construct the kinto client. Remote and options are the same as for KintoClient. There is an
   * additional option `writer` which is the hostname of the settings-writer instance. When
   * authorize() is called, the client will automatically switch to it.
   *
   * @param {string} remote     The remote URL.
   * @param {Object} options    The options object.
   */
  constructor(remote, options={}) {
    let writer = options.writer;
    delete options.writer;

    let auth = options.auth;
    delete options.auth;

    super(remote, options);

    if (writer) {
      this.remote_writer = writer;
    }
    this.remote_reader = remote;
    this.auth = auth || { get: () => {}, set: () => {} };

    let request = this.http.request.bind(this.http);
    this.http.request = this.httpRequest.bind(this, request);
  }

  async httpRequest(origRequest, url, request = { headers: {} }, options = { retry: 0 }) {
    let response;
    try {
      response = await origRequest(url, request, options);
    } catch (e) {
      if (e.data.code == 401) {
        await this.deauthorize();
        await this.authorize();

        request.headers.Authorization = await this.auth.get();
        response = await origRequest(url, request, options);
      } else {
        throw e;
      }
    }

    return response;
  }

  async deauthorize() {
    await this.auth.remove();
    this.authorized = false;
  }

  /**
   * Authorize with the kinto server using LDAP via openid. This will open a browser window for the
   * authentication.
   */
  async authorize() {
    if (this.authorized) {
      return;
    }

    requiresVPN();

    // Make sure we are using the writer when doing authenticated requests
    this.remote = this.remote_writer;

    let authHeader = await this.auth.get();
    if (authHeader) {
      this.setHeaders({ Authorization: authHeader });
      this.authorized = true;
      return;
    }

    let server = http.createServer();

    // Spin up a http server for the OAuth callback
    let port = await new Promise((resolve) => {
      server.listen({
        port: 0,
        host: "127.0.0.1",
        exclusive: true,
      }, () => resolve(server.address().port));
    });

    // Open the URL in the browser to trigger authentication
    let authURL = new URL("/v1/openid/ldap/login?" + querystring.stringify({
      callback: `http://127.0.0.1:${port}/mozblocklist?token=`,
      scope: "openid email"
    }), this.remote);
    open(authURL);

    // Wait for the response from the browser and shut down the http server
    let response = await new Promise((resolve) => {
      server.on("request", (req, res) => {
        let query = urlparse(req.url, true).query;
        if (query.token) {
          let token = Buffer.from(query.token, "base64").toString("ascii");
          let tokendata = JSON.parse(token);
          res.end("OK");
          resolve(tokendata);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("404 Not Found");
        }
      });
    });

    server.close();

    let auth = `${response.token_type} ${response.access_token}`;
    this.setHeaders({ Authorization: auth });
    await this.auth.set(auth);

    this.authorized = true;
  }

  /**
   * Load the blocklist from the blocklists/addons collection.
   */
  async loadBlocklist() {
    let addons = await this.bucket("blocklists").collection("addons").listRecords();

    let guids = new Map();
    let regexes = new Map();

    for (let entry of addons.data) {
      if (!entry.details.created) {
        entry.details.created = new Date(entry.last_modified).toISOString();
      }

      if (entry.guid[0] == "/") {
        regexes.set(new RegExp(entry.guid.substring(1, entry.guid.length - 1)), entry);
      } else if (entry.guid[0] == "^") {
        regexes.set(new RegExp(entry.guid), entry);
      } else {
        guids.set(entry.guid, entry);
      }
    }

    return [guids, regexes];
  }

  /**
   * Create a new blocklist entry.
   *
   * @param {string} guid       The guids, either a single guid or a string with a regex.
   * @param {string} bug        The ID of the bug for this entry.
   * @param {string} name       The name of this block.
   * @param {string} reason     The reason for blocking.
   * @param {number} severity   The severity of the block, defaults to HARD_BLOCK.
   * @param {string} minVersion The minimum version to block, defaults to 0 (first).
   * @param {string} maxVersion The maximum version to block, defaults to * (all).
   * @return {Object}           The blocklist entry from the server.
   */
  async createBlocklistEntry(guid, bug, name, reason, severity=HARD_BLOCK, minVersion="0", maxVersion="*") {
    await this.authorize();

    let entry = await this.bucket("staging", { safe: true }).collection("addons").createRecord({
      guid: guid,
      prefs: [],
      details: {
        bug: `https://bugzilla.mozilla.org/show_bug.cgi?id=${bug}`,
        name: name,
        why: reason
      },
      enabled: true,
      versionRange: [{ severity, minVersion, maxVersion }]
    });

    return entry;
  }

  async getBlocklistPreview() {
    return this.compareAddonCollection("blocklists-preview");
  }

  async getWorkInProgress() {
    return this.compareAddonCollection("staging");
  }

  async compareAddonCollection(compareWithBucket) {
    await this.authorize();

    let collection = await this.bucket("blocklists").collection("addons");

    let { headers } = await collection.client.execute({
      headers: collection._getHeaders({}),
      path: "/buckets/blocklists/collections/addons/records",
      method: "HEAD"
    }, {
      "raw": true,
      "return": collection._getRetry({})
    });

    return this.bucket(compareWithBucket).collection("addons")
      .listRecords({ since: headers.get("ETag") });
  }

  /**
   * Makes sure the blocklist is in one of the requested states, throws an error otherwise.
   *
   * @param {string[]} statii       An array with requested states.
   */
  async ensureBlocklistState(statii) {
    let status = await this.getBlocklistStatus();

    if (!statii.includes(status)) {
      throw new Error(`Expected blocklist to be in states ${statii.join(",")}, but was in ${status}`);
    }
  }

  /**
   * Get the current blocklist status.
   *
   * @return {string}               The current blocklist status.
   */
  async getBlocklistStatus() {
    await this.authorize();
    let data = await this.bucket("staging").collection("addons").getData();
    return data.status;
  }

  /**
   * Update the collection status for the staging/addons collection.
   *
   * @param {string} status     One of the valid collection statii.
   */
  async _updateCollectionStatus(status) {
    await this.authorize();
    await this.bucket("staging").collection("addons").setData({ status }, { patch: true });
  }

  /**
   * Move the status from work in progress to in review.
   */
  async reviewBlocklist() {
    await this.ensureBlocklistState(["work-in-progress"]);
    await this._updateCollectionStatus("to-review");
  }

  /**
   * Sign the entries, moving the status to signed.
   */
  async signBlocklist() {
    await this.ensureBlocklistState(["to-review"]);
    await this._updateCollectionStatus("to-sign");
  }

  /**
   * Reject the review, moving the status to work in progress.
   */
  async rejectBlocklist() {
    await this.ensureBlocklistState(["to-review"]);
    await this._updateCollectionStatus("work-in-progress");
  }
}
