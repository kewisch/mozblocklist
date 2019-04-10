/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2019 */

/**
 * A simple bugzilla REST API client.
 */
class BugzillaClient {
  constructor(baseurl, apikey) {
    this.baseurl = baseurl;
    this.apikey = apikey || "";
  }

  get authenticated() {
    return !!this.apikey;
  }

  async get(ids) {
    return fetch(`${this.baseurl}/rest/bug?id=${ids.join(",")}&api_key=${this.apikey}`).then(resp => resp.json());
  }

  async getComments(ids) {
    let firstid = ids[0];
    let data = fetch(`${this.baseurl}/rest/bug/${firstid}/comment?ids=${ids.join("&ids=")}&api_key=${this.apikey}`).then(resp => resp.json());

    if (data.error) {
      throw new Error(`${data.code} - ${data.message}`);
    }

    return data;
  }

  async update(info) {
    let firstid = info.ids[0];
    let res = await fetch(`${this.baseurl}/rest/bug/${firstid}?api_key=${this.apikey}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(info)
    });

    let data = await res.json();
    if (data.error) {
      throw new Error(`${data.code} - ${data.message}`);
    }

    return data;
  }

  async create(info) {
    let res = await fetch(`${this.baseurl}/rest/bug?api_key=${this.apikey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(info)
    });

    let data = await res.json();
    if (data.error) {
      throw new Error(`${data.code} - ${data.message}`);
    }

    return data.id;
  }

  async whoami() {
    let res = await fetch(`${this.baseurl}/rest/whoami?api_key=${this.apikey}`);
    let data = await res.json();

    if (data.error) {
      throw new Error(`${data.code} - ${data.message}`);
    }

    return data;
  }
}

module.exports = BugzillaClient;
