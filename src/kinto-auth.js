/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2019 */

import keytar from "keytar";
import querystring from "querystring";
import http from "http";
import { open } from "openurl";
import { URL, parse as urlparse } from "url";
import { waitForInput } from "./utils";

export class MemoryAuthStore {
  constructor() {
    this.auth = null;
  }

  async get() {
    return this.auth;
  }

  async set(header) {
    this.auth = header;
  }

  async remove() {
    this.auth = null;
  }
}

export class KeytarAuthStore {
  constructor(service, account) {
    this.service = service;
    this.account = account;
  }

  async get() {
    return keytar.getPassword(this.service, this.account);
  }

  async set(header) {
    return keytar.setPassword(this.service, this.account, header);
  }

  async remove() {
    return keytar.deletePassword(this.service, this.account);
  }
}

class Auth {
  constructor(storage) {
    this.storage = storage;
  }

  async negotiate(remote) {
    // abstract
  }

  async get() {
    return this.storage.get();
  }

  async set(header) {
    return this.storage.set(header);
  }

  async remove() {
    return this.storage.remove();
  }
}

export class KintoBasicAuth extends Auth {
  async negotiate(remote) {
    let username = await waitForInput("Username:", false);
    let password = await waitForInput("Password:", false);

    let buf = new Buffer(`${username}:${password}`);
    return "Basic " + buf.toString("base64");
  }
}

export class KintoOAuth extends Auth {
  async negotiate(remote) {
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
    }), remote);
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

    return `${response.token_type} ${response.access_token}`;
  }
}
