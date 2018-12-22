#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2018 */

var yargs = require("yargs");

var BlocklistKintoClient = require("./kinto-client");
var { regexEscape, waitForStdin, waitForInput, bold } = require("./utils");
var constants = require("./constants");

/**
 * A map between a string guid and its blocklist data
 * @typedef {Map<String,Object>} BlocklistMap
 */

/**
 * A map between regex guids and its blocklist data
 * @typedef {Map<RegExp,Object>} BlocklistRegexMap
 */

/**
 * Reads guids from an array of lines, skipping empty lines or those commented with #
 *
 * @param {Array} lines                 The lines to parse
 * @param {BlocklistMap} guids          The Map with guids and blocklist details as
 *                                        provided by loadBlocklist
 * @param {BlocklistRegexMap} regexes   The Map with regexes and blocklist details as
 *                                        provided by loadBlocklist
 * @return {[BlocklistMap, Set<String>]} An array with existing and new guids
 */
function readGuidData(lines, guids, regexes) {
  let existing = new Map();
  let newguids = new Set();

  for (let line of lines) {
    let guid = line.trim();
    if (!guid || guid.startsWith(constants.COMMENT_CHAR)) {
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

/**
 * Check for guids provided in stdin if they are in the blocklist, optionally creating the blocklist
 * entry. This will start the interactive workflow
 *
 * @param {BlocklistKintoClient} client       The kinto client to maninpulate the blocklist
 * @param {Boolean} create              If true, creation will also be prompted
 * @param {Boolean} canContinue         Also create the entry if there are work in progress items
 */
async function checkGuidsInteractively(client, create=false, canContinue=false) {
  if (process.stdin.isTTY) {
    console.log("Loading blocklist...");
  }

  let [guids, regexes] = await client.loadBlocklist();

  if (process.stdin.isTTY) {
    console.log("Blocklist loaded, waiting for guids (one per line, Ctrl+D to finish)");
  }

  let data = await waitForStdin();
  let [existing, newguids] = readGuidData(data, guids, regexes);
  let newguidvalues = [...newguids.values()];

  console.log("");

  // Show existing guids for information
  if (existing.size) {
    console.log(bold("The following guids are already blocked:"));
    for (let [guid, details] of existing.entries()) {
      console.log(`${guid} - ${details.bug}`);
    }
    console.log("");
  }

  // Show a list of new guids that can be blocked
  if (newguids.size > 0) {
    console.log(bold("Here is a list of all guids not yet blocked:"));
    console.log(newguidvalues.join("\n"));

    if (create) {
      let guidstring;
      if (newguids.size > 1) {
        guidstring = "/^((" + newguidvalues.map(regexEscape).join(")|(") + "))$/";
      } else {
        guidstring = newguidvalues[0];
      }

      await createBlocklistEntryInteractively(client, guidstring, canContinue);
    }
  } else {
    console.log("Nothing new to block");
  }
}

/**
 * Prompt for information required to create a blocklist entry and create it. This requires the
 * blocklist to be clean and not work in progress
 *
 * @param {BlocklistKintoClient} client       The blocklist client to create with
 * @param {String} guids                The guid strings for the blocklist entry
 * @param {Boolean} canContinue         Also create the entry if there are work in progress items
 */
async function createBlocklistEntryInteractively(client, guids, canContinue=false) {
  let usesRegex = guids.startsWith("/");

  let requestedStates = ["signed"];
  if (canContinue) {
    requestedStates.push("work-in-progress");
  }
  await client.ensureBlocklistState(requestedStates);

  let bugid;
  while (true) {
    bugid = await waitForInput("Bug id or link:");
    bugid = bugid.replace("https://bugzilla.mozilla.org/show_bug.cgi?id=", "");
    if (bugid && !isNaN(parseInt(bugid, 10))) {
      break;
    }

    console.log("Invalid bug id or link");
  }

  let name = await waitForInput("Name for this block:", false);
  let reason = await waitForInput("Reason for this block:", false);

  let severity;
  while (true) {
    severity = await waitForInput("Severity [HARD/soft]:");
    if (severity == "hard" || severity == "") {
      severity = constants.HARD_BLOCK;
      break;
    } else if (severity == "soft") {
      severity = constants.SOFT_BLOCK;
      break;
    }

    console.log("Invalid severity, must be hard or soft");
  }

  let minVersion = "0";
  let maxVersion = "*";

  // Only prompt for version when not using a regex, this case is not very common.
  if (!usesRegex) {
    minVersion = await waitForInput("Minimum version [0]:");
    maxVersion = await waitForInput("Maximum version [*]:");
  }

  let answer = await waitForInput("Ready to create and stage the blocklist entry? [yN]");
  if (answer == "y") {
    await client.createBlocklistEntry(guidstring, bugid, name, reason, severity, minVersion, maxVersion);
  }
}

/**
 * Print the current blocklist status in a human readable form
 *
 * @param {BlocklistKintoClient} client       The blocklist client
 */
async function printBlocklistStatus(client) {
  let status = await client.getBlocklistStatus();
  let map = {
    "signed": "Signed and ready",
    "to-sign": "Signed and ready",
    "work-in-progress": "Blocklist entries work in progress",
    "to-review": "Blocklist staged, waiting for review",
    "_": "Unknown: %s"
  };

  let string = (map[status] || map._).replace("%s", stautus);
  console.log(string);
}

/**
 * The main program executed when called
 */
(async function() {
  process.stdin.setEncoding("utf8");

  let argv = yargs
    .option("H", {
      "alias": "host",
      "default": constants.PUBLIC_HOST,
      "describe": "The kinto host to access"
    })
    .option("W", {
      alias: "writer",
      conflicts: "stage",
      // Can't have a real default here because it will conflict with the stage option
      describe: `The writer instance of kinto to use.                      [default: "${constants.PROD_HOST}"]`
    })
    .option("c", {
      "alias": "continue",
      "boolean": true,
      "describe": "Allow creation when there are work in progress items"
    })
    .option("s", {
      "alias": "stage",
      "boolean": true,
      "conflicts": "writer",
      "describe": "Use the stage writer instead of the production writer"
    })
    .command("check", "Find out what entries already exist in the blocklist")
    .command("create", "Stage a block for a set of guids")
    .command("status", "Check the current blocklist status")
    .command("review", "Request review for pending blocklist entries")
    .command("sign", "Sign a pending blocklist review")
    .command("reject", "Reject a pending blocklist review")
    .example("echo guid@example.com | $0 check", "Check if guid@example.com is in the blocklist")
    .example("echo guid@example.com | $0 create", "The same, but also prompt for creating the blocklist entry")
    .example("$0 check", "Interactively enter a list of guids to check in the blocklist")
    .demandCommand(1, "Error: Missing required command")
    .wrap(120)
    .argv;

  let writer;
  let remote;
  if (argv.stage) {
    writer = `https://${constants.STAGE_HOST}/v1/`;
    remote = `https://${constants.STAGE_HOST}/v1/`;
  } else {
    writer = `https://${argv.writer || constants.PROD_HOST}/v1/`;
    remote = `https://${argv.host}/v1/`;
  }
  let client = new BlocklistKintoClient(remote, { writer });

  switch (argv._[0]) {
    case "create":
    case "check":
      await checkGuidsInteractively(client, argv._[0] == "create", !!argv["continue"]);
      break;

    case "status":
      await printBlocklistStatus();
      break;
    case "review":
      await client.reviewBlocklist();
      break;
    case "sign":
      await client.signBlocklist();
      break;
    case "reject":
      await client.rejectBlocklist();
      break;
    default:
      yargs.showHelp();
      break;
  }
})().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
