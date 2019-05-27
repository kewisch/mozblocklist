/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2019 */

import { waitForStdin, waitForInput, bold, getSeverity, createGuidString } from "./utils";
import { COMMENT_CHAR, SOFT_BLOCK, HARD_BLOCK } from "./constants";
import { ADDON_STATUS, DjangoUserModels, AddonAdminPage, getConfig } from "amolib";

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

export default class Mozblocklist {
  constructor({ kinto, bugzilla, redash, amo }) {
    this.kinto = kinto;
    this.bugzilla = bugzilla;
    this.redash = redash;
    this.amo = amo;
  }

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
  readGuidData(lines, guids, regexes) {
    let existing = new Map();
    let newguids = new Set();

    for (let line of lines) {
      let guid = line.trim();
      if (!guid || guid.startsWith(COMMENT_CHAR)) {
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
  compileDescription(name, versions, reason, severity, guids, additionalInfo=null, platformVersions="<all platforms>") {
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
   * Display the blocklist in various formats.
   *
   * @param {string} format                     The format, json or sql.
   * @param {boolean} loadAllGuids              For the SQL format, load guids from the AMO database
   *                                              instead of stdin.
   */
  async displayBlocklist(format="json", loadAllGuids=false) {
    if (format == "json") {
      console.warn("Loading blocklist...");
      let addons = await this.kinto.bucket("blocklists").collection("addons").listRecords();
      console.log(JSON.stringify(addons, null, 2));
    } else if (format == "sql") {
      if (process.stdin.isTTY) {
        console.warn("Loading blocklist...");
      }
      let [blockguids, blockregexes] = await this.kinto.loadBlocklist();

      let data;
      if (loadAllGuids) {
        console.warn("Loading all guids from AMO-DB via redash...");
        data = await this.redash.queryAllIds();
      } else {
        if (process.stdin.isTTY) {
          console.warn("Blocklist loaded, waiting for guids (one per line, Ctrl+D to finish)");
        }
        data = await waitForStdin();
      }

      console.warn("Applying blocklist entries to guids...");

      let { existing } = this.readGuidData(data, blockguids, blockregexes);
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
   * @param {string} reviewerName               The reviewer's name (e.g. First name).
   * @param {string} reviewerEmail              The reviewer's email.
   */
  async reviewBlocklist(reviewerName, reviewerEmail) {
    let pending = await this.displayPending("staging");
    if (!pending.data.length) {
      console.log("No blocks are in progress");
      return;
    }
    let hasReviewer = this.bugzilla.authenticated && reviewerName && reviewerEmail;
    let answer;
    if (hasReviewer) {
      answer = await waitForInput(`Ready to request review from ${reviewerName}? [yN]`);
    } else {
      answer = await waitForInput("Ready to request review? [yN]");
    }

    if (answer == "y") {
      await this.kinto.reviewBlocklist();

      if (hasReviewer) {
        let bugset = new Set();
        for (let entry of pending.data) {
          if (!entry._alreadyRequestedBlock && entry.details) {
            bugset.add(entry.details.bug.match(/id=(\d+)/)[1]);
          }
        }
        let bugs = [...bugset];

        if (bugs.length < pending.data.length) {
          console.warn(`${pending.data.length - bugs.length} bugs already have a request for review`);
        }
        console.warn("Requesting review from ${reviewerName} for the following bugs:");
        for (let bug of bugs) {
          console.warn("\thttps://bugzilla.mozilla.org/show_bug.cgi?id=" + bug);
        }

        await this.bugzilla.update({
          ids: bugs,
          comment: { body: `The block has been staged. ${reviewerName}, can you review and push?` },
          cc: { add: [reviewerEmail] },
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
   */
  async reviewAndSignBlocklist() {
    let pending = await this.displayPending();
    if (pending.data.length) {
      let ready = await waitForInput("Ready to sign? [yN] ");
      if (ready == "y") {
        await this.signBlocklist(pending);
      }
    } else {
      console.log("No stagd blocks");
    }
  }

  /**
   * Sign the blocklist, pushing the block.
   *
   * @param {?Object} pending                   The pending blocklist data in case it was retrieved
   *                                              before.
   */
  async signBlocklist(pending=null) {
    let removeSecurityGroup = false;
    if (this.bugzilla.authenticated) {
      removeSecurityGroup = await waitForInput("Remove blocklist-requests security group? [yN]");
    }

    console.warn("Signing blocklist...");
    let res = pending || await this.kinto.getBlocklistPreview();
    await this.kinto.signBlocklist();

    if (this.bugzilla.authenticated) {
      let bugset = new Set();
      for (let entry of res.data) {
        if (!entry.deleted) {
          bugs.add(entry.details.bug.match(/id=(\d+)/)[1]);
        }
      }
      let bugs = [...bugset];

      console.warn("Marking the following bugs as FIXED:");
      for (let bug of bugs) {
        console.warn("\thttps://bugzilla.mozilla.org/show_bug.cgi?id=" + bug);
      }

      let bugdata = {
        ids: bugs,
        comment: { body: "Done" },
        flags: [{
          name: "needinfo",
          status: "X"
        }],
        resolution: "FIXED",
        status: "RESOLVED"
      };

      if (removeSecurityGroup) {
        bugdata.groups = { remove: ["blocklist-requests"] };
      }
      await this.bugzilla.update(bugdata);

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
   * @param {Object<number,Date>} data          Map between bug id and date.
   * @return {Promise<Object<number,string[]>>} Map between bug id and comments.
   */
  async getCommentsSince(data) {
    let res = await this.bugzilla.getComments(Object.keys(data));
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
   * Display guids pending for blocklisting.
   *
   * @param {string} compareWith                The collection to compare with. This is usually
   *                                              blocklists-preview or staging.
   */
  async displayPendingGuids(compareWith="blocklists-preview") {
    let pending = await this.kinto.compareAddonCollection(compareWith);

    let output = pending.data.reduce((guids, { guid }) => {
      if (guid.startsWith("/")) {
        guids.push(...guid.substring(4, guid.length - 4).split(")|(").map(entry => entry.replace(/\\/g, "")));
      } else {
        guids.push(guid);
      }
      return guids;
    }, []);

    console.log(output.join("\n"));
  }

  /**
   * Display pending blocks.
   *
   * @param {string} compareWith                The collection to compare with. This is usually
   *                                              blocklists-preview or staging.
   * @return {Object}                          Pending blocklist data from kinto.
   */
  async displayPending(compareWith="blocklists-preview") {
    let pending = await this.kinto.compareAddonCollection(compareWith);
    let bugData = {};
    for (let entry of pending.data) {
      if (!entry.deleted) {
        bugData[entry.details.bug.match(/id=(\d+)/)[1]] = new Date(entry.last_modified);
      }
    }

    let comments = pending.data.length ? await this.getCommentsSince(bugData) : {};

    for (let entry of pending.data) {
      console.log(`Entry ${entry.id} - ${entry.deleted ? "deleted" : entry.details.name}`);
      if (!entry.enabled) {
        console.log("\tWarning: The blocklist entry is marked disabled");
      }

      console.log(`\tURL: ${this.kinto.remote_writer}/admin/#/buckets/staging/collections/addons/records/${entry.id}/attributes`);

      if (!entry.deleted) {
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
    }

    if (!pending.data.length) {
      console.log("No blocks pending");
    }

    return pending;
  }

  /**
   * Check for guids provided in stdin if they are in the blocklist, optionally creating the blocklist
   * entry. This will start the interactive workflow.
   *
   * @param {Object} options                    The options for this call, see following.
   * @param {boolean} options.create              If true, creation will also be prompted.
   * @param {boolean} options.canContinue         Also create the entry if there are work in progress items.
   * @param {string[]} options.guids              The guids to check, can be empty.
   * @param {boolean} options.useIds              If add-on ids are used instead.
   * @param {integer} options.bug                 The bug to optionally take information from.
   */
  async checkGuidsInteractively({ create = false, canContinue = false, guids = [], useIds = false, bug = null, allFromUsers = false }) {
    if (process.stdin.isTTY && !guids.length && !bug) {
      console.warn("Loading blocklist...");
    }

    let [blockguids, blockregexes] = await this.kinto.loadBlocklist();

    if (process.stdin.isTTY && !guids.length && !bug) {
      console.warn("Blocklist loaded, waiting for guids (one per line, Ctrl+D to finish)");
    }

    let data;
    let bugData;
    if (bug) {
      bugData = await this.parseBlocklistBug(bug);
      data = bugData.guids;
    } else if (guids.length) {
      data = guids;
    } else {
      data = await waitForStdin();
    }

    if (useIds) {
      console.warn("Querying guids from AMO-DB via redash");
      let result = await this.redash.queryMapIds("id", "guid", data);
      data = [...Object.values(result)];
    }

    let otherguids = await this.redash.queryAddonsInvolvedAccounts(data);
    let alluserguids = [...new Set([...otherguids, ...data])];
    if (!allFromUsers && alluserguids.length > data.length) {
      let diff = alluserguids.length - data.length
      allFromUsers = (await waitForInput(`The users involved have ${diff} more add-ons, also check them? [yN]`) == "y");
    }

    if (allFromUsers) {
      // Get other add-ons, lets make absolutely sure the original guids are contained
      console.warn("Expanding to all add-ons from involved users");
      data = [...new Set([...otherguids, ...data])];
    }

    let { existing, newguids } = this.readGuidData(data, blockguids, blockregexes);
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
        await this.createBlocklistEntryInteractively(newguidvalues, canContinue, bugData);
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
   * Parse a blocklist bug that uses the form.
   *
   * @param {integer} id                    The bug id.
   * @return {Promise<BlocklistBugData>}    The parsed blocklist data.
   */
  async parseBlocklistBug(id) {
    let data = await this.bugzilla.getComments([id]);
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
   * @param {string[]} guids                The guid strings for the blocklist entry.
   * @param {boolean} canContinue           Also create the entry if there are work in progress items.
   * @param {BlocklistBugData} bugData      The data from the blocklist bug for names and reasons.
   */
  async createBlocklistEntryInteractively(guids, canContinue=false, bugData=null) {
    let requestedStates = ["signed"];
    if (canContinue) {
      requestedStates.push("work-in-progress", "to-review");
    }
    await this.kinto.ensureBlocklistState(requestedStates);

    let bugid, name, reason;
    let additionalInfo = null;

    if (bugData) {
      bugid = bugData.id;
    } else {
      while (true) {
        bugid = await waitForInput("Bug id or link (leave empty to create):");
        bugid = bugid.replace("https://bugzilla.mozilla.org/show_bug.cgi?id=", "");

        if (!bugid && !this.bugzilla.authenticated) {
          console.log("You need to specify a bugzilla API key in the config or enter a bug id here");
        } else if (bugid && isNaN(parseInt(bugid, 10))) {
          console.log("Invalid bug id or link");
        } else {
          break;
        }
      }

      if (bugid) {
        bugData = await parseBlocklistBug(bugid);
      }
    }

    let canned = getConfig("mozblocklist", "canned") || {};
    let reasons = Object.keys(canned);


    if (bugData) {
      name = await waitForInput(`Name for this block [${bugData.name}]:`, false) || bugData.name;
    } else {
      name = await waitForInput("Name for this block:", false);
    }

    while (true) {
      reason = await waitForInput(`Reason for this block [${reasons.join(",")},custom]:`, false);
      if (reason == "custom") {
        reason = {
          bugzilla: await waitForInput("Bugzilla reason:", false),
          kinto: await waitForInput("Kinto reason:", false),
        };
        break;
      } else if (canned.hasOwnProperty(reason)) {
        reason = canned[reason];
        if (reason.kinto && reason.bugzilla) {
          break;
        } else {
          console.log("The reason config seems wrong, it needs both a bugzilla and a kinto key");
        }
      } else {
        console.log("Unknown reason, use 'custom' for a custom reason");
      }
    }


    if (!bugData) {
      additionalInfo = await waitForInput("Any additional info for the bug?", false);
    }

    let severity;
    while (true) {
      severity = await waitForInput("Severity [HARD/soft]:");
      if (severity == "hard" || severity == "") {
        severity = HARD_BLOCK;
        break;
      } else if (severity == "soft") {
        severity = SOFT_BLOCK;
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

    let shouldBan = await waitForInput("Ban involved users? [yN]");
    let answer = await waitForInput("Ready to create the blocklist entry? [yN]");
    if (answer == "y") {
      let account = await this.bugzilla.whoami();
      if (bugid) {
        await this.bugzilla.update({
          ids: [bugid],
          comment: { body: reason.bugzilla },
          assigned_to: account.name,
          status: "ASSIGNED"
        });
      } else {
        let versions = minVersion == "0" && maxVersion == "*" ? "<all versions>" : `${minVersion} - ${maxVersion}`;
        let description = this.compileDescription(name, versions, reason.bugzilla, severity, guids, additionalInfo);

        bugid = await this.bugzilla.create({
          product: "Toolkit",
          component: "Blocklist Policy Requests",
          version: "unspecified",
          summary: "Extension block request: " + name,
          description: description,
          whiteboard: "[extension]",
          status: "ASSIGNED",
          assigned_to: account.name,
          groups: ["blocklist-requests"]
        });

        console.log(`Created https://bugzilla.mozilla.org/show_bug.cgi?id=${bugid} for this entry`);
      }

      let guidstring = createGuidString(guids);
      let entry = await this.kinto.createBlocklistEntry(guidstring, bugid, name, reason.kinto, severity, minVersion, maxVersion);
      console.log(`Blocklist entry created, see ${this.kinto.remote_writer}/admin/#/buckets/staging/collections/addons/records/${entry.data.id}/attributes`);


      if (shouldBan == "y") {
        let users = await this.redash.queryUsersForIds("guid", guids);
        console.log("Banning these users:");
        console.log(users.map(user => `\t${user.user_id} (${user.username} - ${user.display_name})`).join("\n"));
        await waitForInput("Really go ahead? [yN]");

        let usermodels = new DjangoUserModels(this.amo);
        await usermodels.ban(users.map(user => user.user_id));
      }

      console.log("Disabling add-on and files");
      let failedguids = [];
      for (let guid of guids) {
        let addonadmin = new AddonAdminPage(this.amo, guid);
        addonadmin.status = ADDON_STATUS.DISABLED;
        try {
          await addonadmin.disableFiles();
        } catch (e) {
          failedguids.push(guid);
        }
      }

      if (failedguids.length) {
        console.log("Could not disable the following add-ons:");
        console.log(failedguids.map(guid => "\t" + guid).join("\n"));
      } else {
        console.log("Done");
      }
    } else {
      console.log("In case you decide to do so later, here is the guid regex:");
      console.log(createGuidString(guids));
    }
  }

  /**
   * Print the current blocklist status in a human readable form.
   */
  async printBlocklistStatus() {
    let status = await this.kinto.getBlocklistStatus();
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
}
