/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2018 */

// Inject fetch so that kinto-http can make use of it
global.fetch = require("node-fetch");

var KintoClient = require("kinto-http");
var { open } = require("openurl");
var querystring = require("querystring");
var http = require("http");
var url = require("url");

var { HARD_BLOCK } = require("./constants");

/**
 * Blocklisting specific version of the KintoClient
 */
class BlocklistKintoClient extends KintoClient {
  /**
   * Construct the kinto client. Remote and options are the same as for KintoClient. There is an
   * additional option `writer` which is the hostname of the settings-writer instance. When
   * authorize() is called, the client will automatically switch to it.
   */
  constructor(remote, options={}) {
    let writer = options.writer;
    delete options.writer;

    super(remote, options);

    if (writer) {
      this.remote_writer = writer;
    }
    this.remote_reader = remote;
    this.authorized = false;
  }

  /**
   * Authorize with the kinto server using LDAP via openid. This will open a browser window for the
   * authentication.
   */
  async authorize() {
    // Make sure we are using the writer when doing authenticated requests
    this.remote = this.remote_writer;

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
    let authURL = new url.URL("/v1/openid/ldap/login?" + querystring.stringify({
      callback: `http://127.0.0.1:${port}/?token=`,
      scope: "openid email"
    }), this.remote);
    open(authURL);

    // Wait for the response from the browser and shut down the http server
    let response = await new Promise((resolve) => {
      server.on("request", (req, res) => {
        let query = url.parse(req.url, true).query;
        if (query.token) {
          res.end("OK");
          resolve(query.token);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("404 Not Found");
        }
      });
    });

    server.close();

    this.setHeaders({ Authorization: `${response.token_type} ${response.access_token}` });

    this.authorized = true;
  }

  /**
   * Make sure the client is authorized.
   */
  async ensureAuthorized() {
    if (!this.authorized) {
      await this.authorize();
    }
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
   * @param {String} guid       The guids, either a single guid or a string with a regex
   * @param {String} bug        The ID of the bug for this entry
   * @param {String} reason     The reason for blocking
   * @param {Number} severity   The severity of the block, defaults to HARD_BLOCK
   * @param {String} minVersion The minimum version to block, defaults to 0 (first)
   * @param {String} maxVersion The maximum version to block, defaults to * (all)
   * @returns {Object}          The blocklist entry from the server
   */
  async createBlocklistEntry(guid, bug, name, reason, severity=HARD_BLOCK, minVersion="0", maxVersion="*") {
    await this.ensureAuthorized();

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

  /**
   * Makes sure the blocklist is in one of the requested states, throws an error otherwise
   *
   * @param {String[]} statii       An array with requested states
   */
  async ensureBlocklistState(statii) {
    await this.ensureAuthorized();
    let data = await this.bucket("staging").collection("addons").getData();

    if (!statii.includes(data.status)) {
      throw new Error(`Expected blocklist to be in states ${statii.join(",")}, but was in ${data.status}`);
    }
  }

  /**
   * Update the collection status for the staging/addons collection
   *
   * @param {String} status     One of the valid collection statii
   */
  async _updateCollectionStatus(status) {
    await this.ensureAuthorized();
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
   * Sign the entries, moving the status to signed
   */
  async signBlocklist() {
    await this.ensureBlocklistState(["to-review"]);
    await this._updateCollectionStatus("to-sign");
  }

  /**
   * Reject the review, moving the status to work in progress
   */
  async rejectBlocklist() {
    await this.ensureBlocklistState(["to-review"]);
    await this._updateCollectionStatus("work-in-progress");
  }
}

module.exports = BlocklistKintoClient;
