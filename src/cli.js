#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2018 */

var yargs = require("yargs");
var RedashClient = require("redash-client");
var ini = require("ini");
var fs = require("fs");
var os = require("os");
var path = require("path");

var BlocklistKintoClient = require("./kinto-client");
var BugzillaClient = require("./bugzilla");
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
 * @param {BlocklistMap} guids          The Map with guids and blocklist entry as
 *                                        provided by loadBlocklist
 * @param {BlocklistRegexMap} regexes   The Map with regexes and blocklist entry as
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
      let entry = guids.get(guid);
      existing.set(guid, entry);
    } else {
      let regexmatches = [...regexes.keys()].filter(re => guid.match(re));
      if (regexmatches.length) {
        if (regexmatches.length > 1) {
          console.error(`Warning: ${guid} appears in more than one regex block: ${regexmatches}`);
        }
        let entry = regexes.get(regexmatches[0]);
        existing.set(guid, entry);
      } else {
        newguids.add(guid);
      }
    }
  }

  return [existing, newguids];
}

async function displayBlocklist(client, format="json", loadAllGuids=false) {
  if (format == "json") {
    console.warn("Loading blocklist...");
    let addons = await client.bucket("blocklists").collection("addons").listRecords();
    console.log(JSON.stringify(addons, null, 2));
  } else if (format == "sql") {
    if (process.stdin.isTTY) {
      console.warn("Loading blocklist...");
    }
    let [blockguids, blockregexes] = await client.loadBlocklist();

    let data;
    if (loadAllGuids) {
      console.warn("Loading all guids from AMO-DB via redash...");
      let result = await redashSQL("SELECT guid FROM addons WHERE guid IS NOT NULL");
      data = result.query_result.data.rows.map(row => row.guid);
    } else {
      if (process.stdin.isTTY) {
        console.warn("Blocklist loaded, waiting for guids (one per line, Ctrl+D to finish)");
      }
      data = await waitForStdin();
    }

    console.warn("Applying blocklist entries to guids...");

    let guiddata = readGuidData(data, blockguids, blockregexes);
    let all = "";

    for (let [guid, entry] of guiddata[0].entries()) {
      let range = entry.versionRange[0];
      let multirange = entry.versionRange.length > 1 ? 1 : 0;
      console.log(
        `${all}SELECT "${guid}" AS guid, "${entry.details.created}" AS created, ` +
        `"${entry.details.bug}" AS bug, ${range.severity} AS severity, ` +
        `"${range.minVersion}" AS minVersion, "${range.maxVersion}" AS maxVersion, ` +
        `${multirange} AS multirange`
      );
      if (!all) {
        all = "UNION ALL ";
      }
    }
  }
}

async function reviewAndSignBlocklist(client, bugzilla) {
  let pending = await displayPending(client, bugzilla);
  let answer = await waitForInput("Ready to sign? [yN] ");
  if (answer == "y") {
    await signBlocklist(client, bugzilla, pending);
  }
}

async function signBlocklist(client, bugzilla, pending=null) {
  console.warn("Signing blocklist...");
  let res = pending || await client.getBlocklistPreview();
  await client.signBlocklist();

  if (bugzilla.authenticated) {
    let bugs = res.data.map(entry => entry.details.bug.match(/id=(\d+)/)[1]);
    console.warn(`Marking bugs ${bugs.join(",")} as FIXED...`);

    await bugzilla.update({
      ids: bugs,
      comment: { body: "Done" },
      flags: [{
        name: "needinfo",
        status: "X"
      }],
      resolution: "FIXED",
      status: "RESOLVED"
    });
    console.warn("Done");
  } else {
    let bugurls = res.data.map(entry => entry.details.bug);
    console.warn("You don't have a bugzilla API key configured. Set one in ~/.amorc or visit these bugs manually:");
    console.warn("\t" + bugurls.join("\n\t"));
  }
}

async function getCommentsSince(bugzilla, data) {
  let res = await bugzilla.getComments(Object.keys(data));
  let comments = {};
  for (let [id, entry] of Object.entries(res.bugs)) {
    comments[id] = [];
    for (let comment of entry.comments) {
      let creation = new Date(comment.creation_time);
      if (creation > data[id]) {
        comments[id].push(`[${comment.time}|${comment.author}] - ${comment.text}`);
      }
    }
  }

  return comments;
}

function getSeverity(severity) {
  let map = { 1: "soft", 3: "hard" };
  return map[severity] || `unknown (${severity})`;
}

async function displayPending(client, bugzilla, compareWith="blocklists-preview") {
  let pending = await client.compareAddonCollection(compareWith);

  let bugData = pending.data.reduce((obj, entry) => {
    obj[entry.details.bug.match(/id=(\d+)/)[1]] = new Date(entry.last_modified);
    return obj;
  }, {});

  let comments = pending.data.length ? await getCommentsSince(bugzilla, bugData) : {};

  for (let entry of pending.data) {
    console.log(`Entry ${entry.id} - ${entry.details.name}`);
    if (!entry.enabled) {
      console.log("\tWarning: The blocklist entry is marked disabled");
    }

    console.log(`\tURL: ${client.remote_writer}/admin/#/buckets/staging/collections/addons/records/${entry.id}/attributes`);

    console.log("\tReason: " + entry.details.why);
    console.log("\tBug: " + entry.details.bug);
    if (entry.versionRange.length == 1 &&
        entry.versionRange[0].minVersion == "0" &&
        entry.versionRange[0].maxVersion == "*") {
      console.log("\tRange: Blocking all versions, severity " + getSeverity(entry.versionRange[0].severity));
    } else {
      console.log("\tRange: Partial block with the following version ranges:");
      for (let range of entry.versionRange) {
        console.log(`\t\t ${range.minVersion} - ${range.maxVersion} (severity ${getSeverity(range.severity)})`);
      }
    }

    if (entry.guid.startsWith("/")) {
      try {
        // eslint-disable-next-line no-new
        new RegExp(entry.guid.substring(1, entry.guid.length - 1));
        console.log("\tGUIDs (valid): " + entry.guid);
      } catch (e) {
        console.log("\tGUIDs (INVALID): " + entry.guid);
      }
    } else {
      console.log("\tGUID: " + entry.guid);
    }

    if (entry.prefs.length) {
      console.log("Prefs: ", entry.prefs);
    }

    let bugId = entry.details.bug.match(/id=(\d+)/)[1];
    if (bugId in comments) {
      console.log("\tComments since the block was staged:");
      for (let comment of comments[bugId]) {
        console.log("\t\t" + comment.replace(/\n/g, "\n\t\t\t"));
      }
    }
  }

  if (!pending.data.length) {
    console.log("No blocks pending");
  }
}

async function redashSQL(sql) {
  let config = ini.parse(fs.readFileSync(path.join(os.homedir(), ".amorc"), "utf-8"));
  if (config && config.auth && config.auth.redash_key) {
    let redash = new RedashClient({
      endPoint: constants.REDASH_URL,
      apiToken: config.auth.redash_key
    });
    let result = await redash.queryAndWaitResult({
      query: sql,
      data_source_id: constants.REDASH_AMO_DB
    });

    return result;
  } else {
    throw new Error("Missing redash API key in ~/.amorc");
  }
}

/**
 * Check for guids provided in stdin if they are in the blocklist, optionally creating the blocklist
 * entry. This will start the interactive workflow
 *
 * @param {BlocklistKintoClient} client       The kinto client to maninpulate the blocklist
 * @param {Object} options                    The options for this call, see following
 * @param {Boolean} options.create              If true, creation will also be prompted
 * @param {Boolean} options.canContinue         Also create the entry if there are work in progress items
 */
async function checkGuidsInteractively(client, { create = false, canContinue = false, guids = [], useIds = false }) {
  if (process.stdin.isTTY && !guids.length) {
    console.warn("Loading blocklist...");
  }

  let [blockguids, blockregexes] = await client.loadBlocklist();

  if (process.stdin.isTTY && !guids.length) {
    console.warn("Blocklist loaded, waiting for guids (one per line, Ctrl+D to finish)");
  }

  let data = guids.length ? guids : await waitForStdin();

  if (useIds) {
    console.warn("Querying guids from AMO-DB via redash");
    let result = await redashSQL(`SELECT guid FROM addons WHERE id IN (${data.join(",")})`);
    data = result.query_result.data.rows.map(row => row.guid);
  }

  let [existing, newguids] = readGuidData(data, blockguids, blockregexes);
  let newguidvalues = [...newguids.values()];

  console.warn("");

  // Show existing guids for information
  if (existing.size) {
    console.log(bold("The following guids are already blocked:"));
    for (let [guid, entry] of existing.entries()) {
      console.log(`${guid} - ${entry.details.bug}`);
    }
    console.log("");
  }

  // Show a list of new guids that can be blocked
  if (newguids.size > 0) {
    console.log(bold("Here is a list of all guids not yet blocked:"));
    console.log(newguidvalues.join("\n"));

    let guidstring;
    if (newguids.size > 1) {
      guidstring = "/^((" + newguidvalues.map(regexEscape).join(")|(") + "))$/";
    } else {
      guidstring = newguidvalues[0];
    }

    if (create) {
      await createBlocklistEntryInteractively(client, guidstring, canContinue);
    } else {
      console.log("");
      console.log(bold("Here is the list of guids for kinto:"));
      console.log(guidstring);
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
    minVersion = await waitForInput("Minimum version [0]:") || "0";
    maxVersion = await waitForInput("Maximum version [*]:") || "*";
  }

  let answer = await waitForInput("Ready to create and stage the blocklist entry? [yN]");
  if (answer == "y") {
    await client.createBlocklistEntry(guids, bugid, name, reason, severity, minVersion, maxVersion);
  } else {
    console.log("In case you decide to do so later, here is the guid regex:");
    console.log(guids);
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

  function checkCreateCommand(type, subyargs) {
    subyargs.positional("guids", {
      describe: `The add-ons guids to ${type}`,
      type: "string",
    })
      .default("guids", [], "<from stdin>")
      .option("i", {
        "alias": "ids",
        "boolean": true,
        "describe": "Take add-on ids instead of guids"
      })
      .option("c", {
        "alias": "continue",
        "boolean": true,
        "describe": "Allow creation when there are work in progress items"
      });
  }

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
    .option("s", {
      "alias": "stage",
      "boolean": true,
      "conflicts": "writer",
      "describe": "Use the stage writer instead of the production writer"
    })
    .command("check [guids..]", "Find out what entries already exist in the blocklist", checkCreateCommand.bind(null, "check"))
    .command("create [guids..]", "Stage a block for a set of guids", checkCreateCommand.bind(null, "create"))
    .command("list", "Display the blocklist in different ways", (subyargs) => {
      subyargs.option("f", {
        "alias": "format",
        "nargs": 1,
        "choices": ["json", "sql"],
        "default": "json",
        "describe": "Output format"
      })
        .option("a", {
          "alias": "all",
          "boolean": true,
          "describe": "Retrieve all guids from redash when using the sql output format"
        })
        .epilog(
          "The 'json' output will show the raw blocklist.\n\n" +
        "The 'sql' output will take a list of guids on stdin (or use the -a option) and show SQL" +
        " statements to create a table out of them. This is useful for further processing on redash."
        );
    })
    .command("status", "Check the current blocklist status")
    .command("review", "Request review for pending blocklist entries")
    .command("pending", "Show blocklist entries pending for signature", (subyargs) => {
      subyargs.option("w", {
        "alias": "wip",
        "boolean": true,
        "describe": "Show work in progress items instead of those pending review"
      });
    })
    .command("sign", "Sign pending blocklist entries after verification")
    .command("reject", "Reject a pending blocklist review")
    .example("echo guid@example.com | $0 check", "Check if guid@example.com is in the blocklist")
    .example("echo 1285960 | $0 check -i", "The same, but check for the AMO id of the add-on")
    .example("echo 1285960 | $0 create -i", "The same, but also prompt for creating the blocklist entry")
    .example("$0 check", "Interactively enter a list of guids to check in the blocklist")
    .demandCommand(1, 1, "Error: Missing required command")
    .wrap(120)
    .argv;

  let writer;
  let remote;
  if (argv.stage) {
    writer = `https://${constants.STAGE_HOST}/v1`;
    remote = `https://${constants.STAGE_HOST}/v1`;
  } else {
    writer = `https://${argv.writer || constants.PROD_HOST}/v1`;
    remote = `https://${argv.host}/v1`;
  }
  let config = ini.parse(fs.readFileSync(path.join(os.homedir(), ".amorc"), "utf-8"));
  let client = new BlocklistKintoClient(remote, { writer });
  let bugzilla = new BugzillaClient("https://bugzilla.mozilla.org", config.auth && config.auth.bugzilla_key);

  switch (argv._[0]) {
    case "list":
      await displayBlocklist(client, argv.format, argv.all || false);
      break;

    case "create":
    case "check":
      await checkGuidsInteractively(client, {
        create: argv._[0] == "create",
        canContinue: !!argv["continue"],
        guids: argv.guids || [],
        useIds: argv.ids
      });
      break;

    case "pending":
      await displayPending(client, bugzilla, argv.wip ? "staging" : "blocklists-preview");
      break;

    case "status":
      await printBlocklistStatus();
      break;
    case "review":
      await client.reviewBlocklist();
      break;
    case "sign":
      await reviewAndSignBlocklist();
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
