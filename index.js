/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2018 */

global.fetch = require("node-fetch");

var KintoClient = require("kinto-http");

const COMMENT_CHAR = "#";
const KINTO_URL = "https://firefox.settings.services.mozilla.com/v1/";

function regexEscape(str) {
  return str.replace(/[\\$^*+.?(){}|[\]]/g, "\\$&");
}

function waitForStdin() {
  return new Promise((resolve, reject) => {
    let chunks = [];
    process.stdin.on("readable", () => {
      let chunk = process.stdin.read();
      if (chunk !== null) {
        chunks.push(chunk);
      }
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => {
      resolve(chunks.join("").trim());
    });
  });
}

async function loadBlocklist() {
  let client = new KintoClient(KINTO_URL);
  let addons = await client.bucket("blocklists").collection("addons").listRecords();

  let guids = new Map();
  let regexes = new Map();

  for (let { guid, details } of addons.data) {
    if (guid[0] == "/") {
      regexes.set(new RegExp(guid.substring(1, guid.length - 1)), details);
    } else {
      guids.set(guid, details);
    }
  }

  return [guids, regexes];
}

function readGuidData(lines, guids, regexes) {
  let existing = new Map();
  let newguids = new Set();

  for (let line of lines) {
    let guid = line.trim();
    if (!guid || guid.startsWith(COMMENT_CHAR)) {
      continue;
    }
    if (guids.has(guid)) {
      let details = guids.get(guid);
      existing.set(guid, details);
    } else {
      let regexmatches = [...regexes.keys()].filter(re => guid.match(re));
      if (regexmatches.length) {
        if (regexmatches.length > 1) {
          console.error(`Warning: ${guid} appears in more than one regex block: ${regexmatches}`);
        }
        let details = regexes.get(regexmatches[0]);
        existing.set(guid, details);
      } else {
        newguids.add(guid);
      }
    }
  }

  return [existing, newguids];
}

(async function() {
  process.stdin.setEncoding("utf8");

  let [guids, regexes] = await loadBlocklist();
  process.stderr.write("Blocklist loaded, go ahead\n");

  let data = await waitForStdin();
  let [existing, newguids] = readGuidData(data.split("\n"), guids, regexes);

  let newguidvalues = [...newguids.values()];

  process.stdout.write("\n");

  if (existing.size) {
    process.stdout.write("The following guids are already blocked:\n");
    for (let [guid, details] of existing.entries()) {
      process.stdout.write(`${guid} - ${details.bug}\n`);
    }
    process.stdout.write("\n");
  }

  if (newguids.size > 0) {
    process.stdout.write("Here is a list of all guids not yet blocked:\n");
    process.stdout.write(newguidvalues.join("\n") + "\n");

    process.stdout.write("\nBlocklist entry for new guids:\n");

    let guidstring;
    if (newguids.size > 1) {
      guidstring = "/^((" + newguidvalues.map(regexEscape).join(")|(") + "))$/";
    } else {
      guidstring = newguidvalues[0];
    }

    process.stdout.write(guidstring + "\n");
  } else {
    process.stdout.write("Nothing new to block\n");
  }
})();
