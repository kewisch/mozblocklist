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
var packageJSON = require("../package.json");

var BlocklistKintoClient = require("./kinto-client");
var BugzillaClient = require("./bugzilla");
var { regexEscape, waitForStdin, waitForInput, bold } = require("./utils");
var constants = require("./constants");

/**
 * A map between a string guid and its blocklist data
 * @typedef {Map<string,Object>} BlocklistMap
 */

/**
 * A map between regex guids and its blocklist data
 * @typedef {Map<RegExp,Object>} BlocklistRegexMap
 */

/**
 * Blocklist bug data.
 *
 * @typedef {Object} BlocklistBugData
 * @property {integer} id                   The bug id
 * @property {string} name                  The extension name, from the block
 * @proeprty {string} reason                The first line of the reason field
 * @property {string[]} guids               The array of guids to block
 */


/**
 * Existing and new guids object.
 *
 * @typedef {Object} GuidData
 * @property {BlocklistMap} existing        The existing guids.
 * @property {Set<string>} newguids         The new guids.
 */

/**
 * Reads guids from an array of lines, skipping empty lines or those commented with #.
 *
 * @param {Array} lines                 The lines to parse.
 * @param {BlocklistMap} guids          The Map with guids and blocklist entry as
 *                                        provided by loadBlocklist.
 * @param {BlocklistRegexMap} regexes   The Map with regexes and blocklist entry as
 *                                        provided by loadBlocklist.
 * @return {GuidData}                   An array with existing and new guids.
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

  return { existing, newguids };
}

/**
 * Display the blocklist in various formats.
 *
 * @param {BlocklistKintoClient} client       The kinto client to access the blocklist.
 * @param {string} format                     The format, json or sql.
 * @param {boolean} loadAllGuids              For the SQL format, load guids from the AMO database
 *                                              instead of stdin.
 */
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

    let { existing } = readGuidData(data, blockguids, blockregexes);
    let all = "";

    for (let [guid, entry] of existing.entries()) {
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

/**
 * Send work in progress blocks to review.
 *
 * @param {BlocklistKintoClient} client       The kinto client to maninpulate the blocklist.
 * @param {BugzillaClient} bugzilla           The bugzilla client to file and update bugs.
 * @param {string} reviewerName               The reviewer's name (e.g. First name).
 * @param {string} reviewerEmail              The reviewer's email.
 */
async function reviewBlocklist(client, bugzilla, reviewerName, reviewerEmail) {
  let pending = await displayPending(client, bugzilla, "staging");
  let hasReviewer = bugzilla.authenticated && reviewerName && reviewerEmail;
  let answer;
  if (hasReviewer) {
    answer = await waitForInput(`Ready to request review from ${reviewerName}? [yN]`);
  } else {
    answer = await waitForInput("Ready to request review? [yN]");
  }

  if (answer == "y") {
    await client.reviewBlocklist();

    if (hasReviewer) {
      let bugs = pending.data
        .filter(entry => !entry._alreadyRequestedBlock)
        .map(entry => entry.details.bug.match(/id=(\d+)/)[1]);

      if (bugs.length < pending.data.length) {
        console.warn(`${pending.data.length - bugs.length} bugs already have a request for review`);
      }
      console.warn(`Requesting review from ${reviewerName} for bugs ${bugs.join(",")}...`);

      await bugzilla.update({
        ids: bugs,
        comment: { body: `The block has been staged. ${reviewerName}, can you review and push?` },
        flags: [{
          name: "needinfo",
          status: "?",
          requestee: reviewerEmail
        }]
      });
    } else {
      let bugurls = pending.data.map(entry => entry.details.bug);
      console.warn("You don't have a bugzilla API key or reviewers configured. Set one in ~/.amorc" +
                   " or visit these bugs manually:");
      console.warn("\t" + bugurls.join("\n\t"));
    }
  }
}

/**
 * Show blocks in the preview list and then sign after asking.
 *
 * @param {BlocklistKintoClient} client       The kinto client to maninpulate the blocklist.
 * @param {BugzillaClient} bugzilla           The bugzilla client to file and update bugs.
 */
async function reviewAndSignBlocklist(client, bugzilla) {
  let pending = await displayPending(client, bugzilla);
  let answer = await waitForInput("Ready to sign? [yN] ");
  if (answer == "y") {
    await signBlocklist(client, bugzilla, pending);
  }
}

/**
 * Sign the blocklist, pushing the block.
 *
 * @param {BlocklistKintoClient} client       The kinto client to maninpulate the blocklist.
 * @param {BugzillaClient} bugzilla           The bugzilla client to file and update bugs.
 * @param {?Object} pending                   The pending blocklist data in case it was retrieved
 *                                              before.
 */
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
    console.warn("You don't have a bugzilla API key configured. Set one in ~/.amorc or visit" +
                 " these bugs manually:");
    console.warn("\t" + bugurls.join("\n\t"));
  }
}

/**
 * Get bugzilla comments since a certain date.
 *
 * @param {BugzillaClient} bugzilla           The bugzilla client to file and update bugs.
 * @param {Object<number,Date>} data          Map between bug id and date.
 * @return {Promise<Object<number,string[]>>} Map between bug id and comments.
 */
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

/**
 * Get the severity string based on the constant.
 *
 * @param {number} severity     The severity constant.
 * @return {string}             The severity string.
 */
function getSeverity(severity) {
  let map = { 1: "soft", 3: "hard" };
  return map[severity] || `unknown (${severity})`;
}

/**
 * Display pending blocks.
 *
 * @param {BlocklistKintoClient} client       The kinto client to maninpulate the blocklist.
 * @param {BugzillaClient} bugzilla           The bugzilla client to file and update bugs.
 * @param {string} compareWith                The collection to compare with. This is usually
 *                                              blocklists-preview or staging.
 * @return {Object}                          Pending blocklist data from kinto.
 */
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
        if (comment.includes("The block has been staged")) {
          entry._alreadyRequestedBlock = true;
        }
      }
    }
  }

  if (!pending.data.length) {
    console.log("No blocks pending");
  }

  return pending;
}

/**
 * Get SQL data from redash.
 *
 * @param {string} sql          The SQL to query.
 * @return {Promise<Object>}    The redash response.
 */
async function redashSQL(sql) {
  let config = ini.parse(fs.readFileSync(path.join(os.homedir(), ".amorc"), "utf-8"));
  if (config && config.auth && config.auth.redash_key) {
    let redash = new RedashClient({
      endPoint: constants.REDASH_URL,
      apiToken: config.auth.redash_key,
      agent: `${packageJSON.name}/${packageJSON.version}`
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
 * entry. This will start the interactive workflow.
 *
 * @param {BlocklistKintoClient} client       The kinto client to maninpulate the blocklist.
 * @param {BugzillaClient} bugzilla           The bugzilla client to file and update bugs.
 * @param {Object} options                    The options for this call, see following.
 * @param {boolean} options.create              If true, creation will also be prompted.
 * @param {boolean} options.canContinue         Also create the entry if there are work in progress items.
 * @param {string[]} options.guids              The guids to check, can be empty.
 * @param {boolean} options.useIds              If add-on ids are used instead.
 * @param {integer} options.bug                 The bug to optionally take information from.
 */
async function checkGuidsInteractively(client, bugzilla, { create = false, canContinue = false, guids = [], useIds = false, bug = null }) {
  if (process.stdin.isTTY && !guids.length && !bug) {
    console.warn("Loading blocklist...");
  }

  let [blockguids, blockregexes] = await client.loadBlocklist();

  if (process.stdin.isTTY && !guids.length && !bug) {
    console.warn("Blocklist loaded, waiting for guids (one per line, Ctrl+D to finish)");
  }

  let data;
  let bugData;
  if (bug) {
    bugData = await parseBlocklistBug(bugzilla, bug);
    data = bugData.guids;
  } else if (guids.length) {
    data = guids;
  } else {
    data = await waitForStdin();
  }

  if (useIds) {
    console.warn("Querying guids from AMO-DB via redash");
    let result = await redashSQL(`SELECT guid FROM addons WHERE id IN (${data.join(",")})`);
    data = result.query_result.data.rows.map(row => row.guid);
  }

  let { existing, newguids } = readGuidData(data, blockguids, blockregexes);
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

    if (create) {
      await createBlocklistEntryInteractively(client, bugzilla, newguidvalues, canContinue, bugData);
    } else {
      console.log("");
      console.log(bold("Here is the list of guids for kinto:"));
      console.log(createGuidString(newguidvalues));
    }
  } else {
    console.log("Nothing new to block");
  }
}

/**
 * Create the markdown description for new blocklisting bugs.
 *
 * @param {string} name                 The extension name.
 * @param {string} versions             The version range(s).
 * @param {string} reason               The reason to block.
 * @param {number} severity             The blocklist severity constant.
 * @param {string[]} guids              An array of guids to block.
 * @param {?string} additionalInfo      Additional information for the bug.
 * @param {?string} platformVersions    The platform version range.
 * @return {string}                     The markdown description.
 */
function compileDescription(name, versions, reason, severity, guids, additionalInfo=null, platformVersions="<all platforms>") {
  /**
   * Removes backticks from the start of each line for use in a backticked string.
   *
   * @param {string} str    Input string.
   * @return {string}       The removed backtick string.
   */
  function backtick(str) {
    return str.replace(/^\s*```/mg, "").trim();
  }

  /**
   * Replaces links in the string with hxxp:// links, except for AMO links.
   *
   * @param {string} str    Input string.
   * @return {string}       The sanitized string.
   */
  function unlink(str) {
    return str.replace(/http(s?):\/\/(?!(reviewers\.)?addons.mozilla.org)/g, "hxxp$1://");
  }

  /**
   * Create a markdown table with an empty header based on the array. The array is an array of rows.
   * Each row is an array of columns.
   *
   * @param {Array<string[]>} arr        Array of cells.
   * @return {string}                    The markdown table.
   */
  function table(arr) {
    function escapeTable(str) { // eslint-disable-line require-jsdoc
      return str.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
    }
    return "| | |\n|-|-|\n|" + arr.map((row) => {
      return row.map(escapeTable).join("|");
    }).join("|\n|") + "|\n";
  }

  let descr = table([
    ["Extension name", name],
    ["Extension versions affected", versions],
    ["Platforms affected", platformVersions],
    ["Block severity", getSeverity(severity)]
  ]);

  descr += "\n### Reason\n" + unlink(reason);
  descr += "\n\n### Extension GUIDs\n```\n" + backtick(guids.join("\n")) + "\n```";

  if (additionalInfo) {
    descr += "\n\n### Additional Information\n" + unlink(additionalInfo.trim());
  }

  return descr;
}

/**
 * Parse a blocklist bug that uses the form.
 *
 * @param {BugzillaClient} bugzilla       The bugzilla client for retrieving comments.
 * @param {integer} id                    The bug id.
 * @return {Promise<BlocklistBugData>}    The parsed blocklist data.
 */
async function parseBlocklistBug(bugzilla, id) {
  let data = await bugzilla.getComments([id]);
  let text = data.bugs[id].comments[0].text;

  let matches = text.match(/Extension name\|([^|]*)\|/);
  let name = matches && matches[1].trim();

  matches = text.match(/### Extension (GU)?IDs\n```([\s\S]+)\n```/);
  let guids = matches && matches[2].trim().split("\n");


  matches = text.match(/### Reason\n([^#]+)/);
  let reason = matches && matches[1].trim().split("\n")[0];

  if (!name || !reason || !guids) {
    console.warn("Not a blocklist bug using the form");
    return null;
  }

  return { id, name, reason, guids };
}

/**
 * Prompt for information required to create a blocklist entry and create it. This requires the
 * blocklist to be clean and not work in progress.
 *
 * @param {BlocklistKintoClient} client   The blocklist client to create with.
 * @param {BugzillaClient} bugzilla       The bugzilla client to file and update bugs.
 * @param {string[]} guids                The guid strings for the blocklist entry.
 * @param {boolean} canContinue           Also create the entry if there are work in progress items.
 * @param {BlocklistBugData} bugData      The data from the blocklist bug for names and reasons.
 */
async function createBlocklistEntryInteractively(client, bugzilla, guids, canContinue=false, bugData=null) {
  let requestedStates = ["signed"];
  if (canContinue) {
    requestedStates.push("work-in-progress", "to-review");
  }
  await client.ensureBlocklistState(requestedStates);

  let bugid, name, reason;
  let additionalInfo = null;

  if (bugData) {
    bugid = bugData.id;
  } else {
    while (true) {
      bugid = await waitForInput("Bug id or link (leave empty to create):");
      bugid = bugid.replace("https://bugzilla.mozilla.org/show_bug.cgi?id=", "");

      if (!bugid && !bugzilla.authenticated) {
        console.log("You need to specify a bugzilla API key in the config or enter a bug id here");
      } else if (bugid && isNaN(parseInt(bugid, 10))) {
        console.log("Invalid bug id or link");
      } else {
        break;
      }
    }

    if (bugid) {
      bugData = await parseBlocklistBug(bugzilla, bugid);
    }
  }

  if (bugData) {
    name = await waitForInput(`Name for this block [${bugData.name}]:`, false) || bugData.name;
    reason = await waitForInput(`Reason for this block [${bugData.reason}]:`, false) || bugData.reason;
  } else {
    name = await waitForInput("Name for this block:", false);
    reason = await waitForInput("Reason for this block:", false);
    additionalInfo = await waitForInput("Any additional info for the bug?", false);
  }

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
  if (guids.length == 1) {
    minVersion = await waitForInput("Minimum version [0]:") || "0";
    maxVersion = await waitForInput("Maximum version [*]:") || "*";
  }

  let answer = await waitForInput("Ready to create the blocklist entry? [yN]");
  if (answer == "y") {
    if (!bugid) {
      let versions = minVersion == "0" && maxVersion == "*" ? "<all versions>" : `${minVersion} - ${maxVersion}`;
      let description = compileDescription(name, versions, reason, severity, guids, additionalInfo);
      let account = await bugzilla.whoami();

      bugid = await bugzilla.create({
        product: "Toolkit",
        component: "Blocklist Policy Requests",
        version: "unspecified",
        summary: "Extension block request: " + name,
        description: description,
        whiteboard: "[extension]",
        status: "ASSIGNED",
        assigned_to: account.name
      });

      console.log(`Created https://bugzilla.mozilla.org/show_bug.cgi?id=${bugid} for this entry`);
    }

    let guidstring = createGuidString(guids);
    let entry = await client.createBlocklistEntry(guidstring, bugid, name, reason, severity, minVersion, maxVersion);
    console.log(`\tDone, see ${client.remote_writer}/admin/#/buckets/staging/collections/addons/records/${entry.data.id}/attributes`);
  } else {
    console.log("In case you decide to do so later, here is the guid regex:");
    console.log(createGuidString(guids));
  }
}

/**
 * Create the kinto guid string, so string with regex or a simple uuid.
 *
 * @param {string[]} guids      The array of guids.
 * @return {string}             The compiled guid string.
 */
function createGuidString(guids) {
  if (guids.length > 1) {
    return "/^((" + guids.map(regexEscape).join(")|(") + "))$/";
  } else {
    return guids[0];
  }
}

/**
 * Print the current blocklist status in a human readable form.
 *
 * @param {BlocklistKintoClient} client       The blocklist client.
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

  let string = (map[status] || map._).replace("%s", status);
  console.log(string);
}

/**
 * The main program executed when called.
 */
(async function() {
  process.stdin.setEncoding("utf8");

  /**
   * The yargs handler function for the check and create commands. The type argument should be bound.
   *
   * @param {string} type       The type of command (check/create).
   * @param {Object} subyargs   The yargs object.
   */
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
      })
      .option("B", {
        alias: "bug",
        conflicts: "ids",
        describe: type + " blocks from given bug"
      });
  }

  let config = ini.parse(fs.readFileSync(path.join(os.homedir(), ".amorc"), "utf-8"));

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
    .command("review", "Request review for pending blocklist entries", (subyargs) => {
      subyargs.option("r", {
        "alias": "reviewer",
        "type": "array",
        "default": [],
        "coerce": (reviewer) => {
          if (reviewer.length == 1) {
            let caseMap = new Map(Object.keys(config.reviewers || {}).map(name => [name.toLowerCase(), name]));
            let name = reviewer[0].toLowerCase();
            if (caseMap.has(name)) {
              reviewer = config.reviewers[caseMap.get(name)].split(",");
            } else {
              throw new Error("Error: Could not find reviewer alias " + reviewer[0]);
            }
          } else if (reviewer.length == 2) {
            if (!reviewer[1].includes("@")) {
              throw new Error(`Error: ${reviewer[1]} is not an email address`);
            }
          } else if (reviewer.length != 0) {
            throw new Error("Invalid reviewer arguments: " + reviewer.join(" "));
          }

          return reviewer;
        },
        "describe": "A reviewer alias from ~/.amorc that will review and push the block, or the name and email of the reviewer"
      });
    })
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
    .config(config ? config.mozblocklist || {} : {})
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
  let client = new BlocklistKintoClient(remote, { writer });
  let bugzilla = new BugzillaClient("https://bugzilla.mozilla.org", config.auth && config.auth.bugzilla_key);

  switch (argv._[0]) {
    case "list":
      await displayBlocklist(client, argv.format, argv.all || false);
      break;

    case "create":
    case "check":
      await checkGuidsInteractively(client, bugzilla, {
        create: argv._[0] == "create",
        canContinue: !!argv["continue"],
        guids: argv.guids || [],
        useIds: argv.ids,
        bug: argv.bug
      });
      break;

    case "pending":
      await displayPending(client, bugzilla, argv.wip ? "staging" : "blocklists-preview");
      break;

    case "status":
      await printBlocklistStatus(client);
      break;
    case "review":
      await reviewBlocklist(client, bugzilla, argv.reviewer[0], argv.reviewer[1]);
      break;
    case "sign":
      await reviewAndSignBlocklist(client, bugzilla);
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
