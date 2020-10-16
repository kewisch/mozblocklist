/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2019 */

import { SingleBar, Presets } from "cli-progress";
import { waitForStdin, waitForInput, waitForValidInput, bold, colored, getSeverity, createGuidStrings, expandGuidRegex, pluralForm } from "./utils";
import { COMMENT_CHAR, HARD_BLOCK, DECIMAL_FORMAT, HIGH_NUMBER_OF_USERS } from "./constants";
import { ADDON_STATUS, DjangoUserModels, AddonAdminPage, getConfig, detectIdType } from "amolib";

/**
 * A map between a string guid and its blocklist data.
 *
 * @typedef {Map<string, object>} BlocklistMap
 */

/**
 * A map between regex guids and its blocklist data.
 *
 * @typedef {Map<RegExp, object>} BlocklistRegexMap
 */

/**
 * Blocklist bug data.
 *
 * @typedef {object} BlocklistBugData
 * @property {integer} id                   The bug id.
 * @property {string} name                  The extension name, from the block.
 * @property {string} reason                The first line of the reason field.
 * @property {string[]} guids               The array of guids to block.
 */

/**
 * Existing and new guids object.
 *
 * @typedef {object} GuidData
 * @property {BlocklistMap} existing        The existing guids.
 * @property {Set<string>} newguids         The new guids.
 */

export default class Mozblocklist {
  constructor({ kinto, kintoapprover, bugzilla, redash, redash_telemetry, amo, usersheet, globalOpts }) {
    this.kinto = kinto;
    this.kintoapprover = kintoapprover;
    this.bugzilla = bugzilla;
    this.redash = redash;
    this.redash_telemetry = redash_telemetry;
    this.amo = amo;
    this.usersheet = usersheet;
    this.globalOpts = globalOpts;
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

      let regexmatches = [...regexes.keys()].filter(re => guid.match(re));

      if (guids.has(guid)) {
        let entry = guids.get(guid);
        if (regexmatches.length) {
          console.error(`Warning: ${guid} appears in a single and a regex block: ${regexmatches}`);
        }
        existing.set(guid, entry);
      } else if (regexmatches.length) {
        if (regexmatches.length > 1) {
          console.error(`Warning: ${guid} appears in more than one regex block: ${regexmatches}`);
        }
        let entry = regexes.get(regexmatches[0]);
        existing.set(guid, entry);
      } else {
        newguids.add(guid);
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
   * @param {string[]} guids              An array of guids to block.
   * @param {?string} additionalInfo      Additional information for the bug.
   * @param {?string} platformVersions    The platform version range.
   * @return {string}                     The markdown description.
   */
  compileDescription(name, versions, reason, guids, additionalInfo=null, platformVersions="<all platforms>") {
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
   * @param {string} format           The format, json or sql.
   * @param {boolean} loadAllGuids    For the SQL format, load guids from the AMO database
   *                                    instead of stdin.
   * @param {string} bucket           The bucket to read from
   *                                    (staging/blocklists-preview/blocklists).
   */
  async displayBlocklist(format="json", loadAllGuids=false, bucket="blocklists") {
    if (format == "json") {
      console.warn("Loading blocklist...");
      if (bucket != "blocklists") {
        await this.kinto.authorize();
      }
      let addons = await this.kinto.bucket(bucket).collection("addons").listRecords();
      console.log(JSON.stringify(addons, null, 2));
    } else if (format == "sql") {
      if (process.stdin.isTTY) {
        console.warn("Loading blocklist...");
      }
      let [blockguids, blockregexes] = await this.kinto.loadBlocklist(bucket);

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
   * @param {object} options                    The options for this function.
   * @param {string} options.reviewerName       The reviewer's name (e.g. First name).
   * @param {string} options.reviewerEmail      The reviewer's email.
   * @param {string} options.showUsage          Show usage information.
   */
  async reviewBlocklist({ reviewerName, reviewerEmail, showUsage }) {
    let pending = await this.displayPending({ compareWith: "staging", showUsage });
    if (!pending.data.length) {
      console.log("No blocks are in progress");
      return;
    }
    let hasReviewer = this.bugzilla.authenticated && reviewerName && reviewerEmail;
    let reviewFrom = hasReviewer ? " from " + reviewerName : "";
    let answer = await waitForValidInput(`Ready to request review${reviewFrom}?`, "yn");

    if (answer == "y") {
      await this.kinto.reviewBlocklist();

      if (hasReviewer) {
        let bugset = new Set();
        for (let entry of pending.data) {
          if (!entry._alreadyRequestedBlock && entry.details && entry.details.bug) {
            bugset.add(entry.details.bug.match(/id=(\d+)/)[1]);
          }
        }
        let bugs = [...bugset];

        if (bugs.length < pending.data.length) {
          console.warn(`${pending.data.length - bugs.length} bugs already have a request for review`);
        }
        console.warn(`Requesting review from ${reviewerName} for the following bugs:`);
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
   *
   * @param {object} options                    The options for this function.
   * @param {boolean} options.selfsign          If true, signing will occur using the shared key.
   * @param {boolean} options.showUsage         If true, usage information will be shown.
   */
  async reviewAndSignBlocklist({ selfsign=false, showUsage=false }) {
    let pending = await this.displayPending({ showUsage });
    let signparams;
    if (pending.data.length) {
      signparams = { pending, selfsign, selfreview: selfsign };
    } else if (selfsign) {
      pending = await this.displayPending({ compareWith: "staging", showUsage });
      signparams = { selfreview: true, selfsign: true };
    }

    if (pending && pending.data.length) {
      let ready = await waitForValidInput(`Ready to ${selfsign ? "self-" : ""}sign?`, "yn");
      if (ready == "y") {
        await this.signBlocklist(signparams);
        await this.recordUsers(pending);
      }
    } else {
      console.log("No staged blocks");
    }
  }

  /**
   * Record the users per guid in the user sheet, if configured.
   *
   * @param {?object} pending           The pending blocklist data in case it was retrieved
   *                                      before. This data will not be used when
   *                                      self-reviewing and self-signing at the same time.
   */
  async recordUsers(pending) {
    if (!pending._usage) {
      if (this.globalOpts.debug) {
        console.log("Could not find usage information to record user sheets");
      }
      return;
    }

    if (!this.usersheet.enabled) {
      if (this.globalOpts.debug) {
        console.log("User sheets recording is disabled, check your config");
      }
      return;
    }

    let rows = pending.data.reduce((acc, entry) => {
      let isodate = entry.details.created || new Date(entry.last_modified).toISOString();
      let cleandate = isodate.replace(/\.\d+Z$/, "").replace("T", " ");
      let guids = expandGuidRegex(entry.guid);
      for (let guid of guids) {
        acc.push([cleandate, guid, entry.details.bug, pending._usage[guid] || 0]);
      }
      return acc;
    }, []);

    let res = await this.usersheet.appendUserRows(rows);
    let range = res.data.updates.updatedRange.split("!", 2);
    console.log("Updated user sheet at " + range[1]);
  }

  /**
   * Sign the blocklist, pushing the block.
   *
   * @param {object} options                    The options for this function.
   * @param {?object} options.pending           The pending blocklist data in case it was retrieved
   *                                              before. This data will not be used when
   *                                              self-reviewing and self-signing at the same time.
   * @param {boolean} options.selfsign          If true, signing will occur using the shared key.
   * @param {boolean} options.selfreview        If true, staged entries will be submitted for
   *                                              review.
   */
  async signBlocklist({ pending=null, selfsign=false, selfreview=false }) {
    let removeSecurityGroup = false;
    if (this.bugzilla.authenticated) {
      removeSecurityGroup = (await waitForInput("Remove blocklist-requests security group? [yN]") == "y");
    }

    if (selfsign && selfreview && pending) {
      throw new Error("Don't pass pending when self-signing and self-reviewing");
    }

    let res;
    if (selfsign) {
      if (selfreview) {
        await this.kinto.reviewBlocklist();
        res = await this.kinto.getBlocklistPreview();
      } else {
        res = pending || await this.kinto.getBlocklistPreview();
      }
      await this.kintoapprover.signBlocklist();
    } else {
      res = pending || await this.kinto.getBlocklistPreview();
      await this.kinto.signBlocklist();
    }

    let bugset = new Set();
    for (let entry of res.data) {
      if (!entry.deleted && entry.details.bug) {
        bugset.add(entry.details.bug.match(/id=(\d+)/)[1]);
      }
    }
    let bugs = [...bugset];

    if (this.bugzilla.authenticated && bugs.length) {
      console.warn("Marking the following bugs as FIXED:");
      for (let bug of bugs) {
        console.warn("\thttps://bugzilla.mozilla.org/show_bug.cgi?id=" + bug);
      }

      let bugdata = {
        ids: bugs,
        resolution: "FIXED",
        status: "RESOLVED"
      };

      if (selfsign) {
        bugdata.comment = { body: "The block has been pushed." };
      } else {
        bugdata.comment = { body: "Done." };
        bugdata.flags = [{
          name: "needinfo",
          status: "X"
        }];
      }

      if (removeSecurityGroup) {
        bugdata.groups = { remove: ["blocklist-requests"] };
      }

      try {
        await this.bugzilla.update(bugdata);
      } catch (e) {
        if (e.response &&
            e.response.statusCode == 401 &&
            e.response.body &&
            e.response.body.code == 120) {
          // Removing the group failed, probably not allowed or already removed.
          delete bugdata.groups;
          await this.bugzilla.update(bugdata);
        } else {
          throw e;
        }
      }

      console.warn("Done");
    } else if (bugs.length) {
      let bugurls = res.data.map(entry => entry.details.bug);
      console.warn("You don't have a bugzilla API key configured. Set one in ~/.amorc or visit" +
                   " these bugs manually:");
      console.warn("\t" + bugurls.join("\n\t"));
    }
  }

  /**
   * Get bugzilla comments since a certain date.
   *
   * @param {object<number, Date>} data          Map between bug id and date.
   * @return {Promise<object<number, Array<string>>>} Map between bug id and comments.
   */
  async getCommentsSince(data) {
    let bugs = Object.keys(data);
    if (!bugs.length) {
      return {};
    }

    let res = await this.bugzilla.getComments(bugs);
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

  async showUsage(guids) {
    let usage = await this.redash_telemetry.queryUsage(guids);
    let missing = guids.filter(guid => !(guid in usage));
    if (missing.length) {
      console.log(bold("Usage numbers for the following guids were not found:"));
      console.log("\t" + missing.join("\n\t") + "\n");
    }

    let total = 0;

    console.log(Object.entries(usage).map(([guid, users]) => {
      let usercount = colored(users > HIGH_NUMBER_OF_USERS ? colored.RED : colored.RESET, DECIMAL_FORMAT.format(users));
      total += users;
      return `${guid} - ${usercount}`;
    }).join("\n"));

    console.log("\nTotal: " + colored(total > HIGH_NUMBER_OF_USERS ? colored.RED : colored.RESET, DECIMAL_FORMAT.format(total)));
  }

  /**
   * Display pending blocks.
   *
   * @param {string} compareWith                The collection to compare with. This is usually
   *                                              blocklists-preview or staging.
   * @return {object}                          Pending blocklist data from kinto.
   */
  async displayPending({ compareWith="blocklists-preview", showUsage=false }) {
    let pending = await this.kinto.compareAddonCollection(compareWith);
    let bugData = {};
    let singleGuids = [];
    let regexToGuids = {};
    for (let entry of pending.data) {
      if (!entry.deleted && entry.details.bug) {
        bugData[entry.details.bug.match(/id=(\d+)/)[1]] = new Date(entry.last_modified);
      }

      if (entry.guid) {
        let guids = expandGuidRegex(entry.guid);
        singleGuids = singleGuids.concat(guids);
        regexToGuids[entry.guid] = guids;
      }
    }

    let usage = 0;
    if (showUsage && singleGuids.length) {
      usage = await this.redash_telemetry.queryUsage(singleGuids);
      let missing = singleGuids.filter(guid => !(guid in usage));
      if (missing.length) {
        console.log(bold("Usage numbers for the following guids were not found:"));
        console.log("\t" + missing.join("\n\t") + "\n");
      }
      pending._usage = usage;
    }

    let comments = pending.data.length ? await this.getCommentsSince(bugData) : {};

    for (let entry of pending.data) {
      console.log(bold(`Entry ${entry.id} - ${entry.deleted ? "deleted" : entry.details.name}`));
      if (!entry.enabled) {
        console.log("\tWarning: The blocklist entry is marked disabled");
      }

      console.log(`\tURL: ${this.kinto.remote_writer}/admin/#/buckets/staging/collections/addons/records/${entry.id}/attributes`);

      if (!entry.deleted) {
        console.log("\tReason: " + entry.details.why);
        if (entry.details.bug) {
          console.log("\tBug: " + entry.details.bug);
        }
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
          if (regexToGuids[entry.guid] && regexToGuids[entry.guid].length) {
            try {
              // eslint-disable-next-line no-new
              new RegExp(entry.guid.substring(1, entry.guid.length - 1));
              console.log("\tGUIDs (valid): " + entry.guid);
            } catch (e) {
              console.log(colored(colored.RED, "\tGUIDs (INVALID, regex doesn't parse): " + entry.guid));
            }
          } else {
            console.log(colored(colored.RED, "\tGUIDs (INVALID, could not split): " + entry.guid));
          }
        } else {
          console.log("\tGUID: " + entry.guid);
        }

        if (showUsage) {
          let users = regexToGuids[entry.guid].reduce((acc, guid) => acc + (usage[guid] || 0), 0);
          console.log(colored(users > HIGH_NUMBER_OF_USERS ? colored.RED : colored.RESET, "\tUsers: " + DECIMAL_FORMAT.format(users)));
          if (this.globalOpts.debug) {
            // This can be a lot of information, only show this on debug
            for (let guid of regexToGuids[entry.guid]) {
              console.log(`\t\t${guid} - ${DECIMAL_FORMAT.format(usage[guid] || 0)}`);
            }
          }
        }

        if (entry.prefs.length) {
          console.log("Prefs: ", entry.prefs);
        }

        let bugId = entry.details.bug && entry.details.bug.match(/id=(\d+)/)[1];
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
      console.log("");
    }

    return pending;
  }

  /**
   * Check for guids provided in stdin if they are in the blocklist, optionally creating the blocklist
   * entry. This will start the interactive workflow.
   *
   * @param {object} options                    The options for this call, see following.
   * @param {boolean} options.create              If true, creation will also be prompted.
   * @param {boolean} options.canContinue         Also create the entry if there are work in progress items.
   * @param {string[]} options.guids              The guids to check, can be empty.
   * @param {integer} options.bug                 The bug to optionally take information from.
   * @param {string} options.bucket             The bucket to read from
   *                                              (staging/blocklists-preview/blocklists).
   */
  async checkGuidsInteractively({ create = false, canContinue = false, guids = [], bug = null, allFromUsers = false, selfsign = false, showUsage = false, bucket = "blocklists" }) {
    if (process.stdin.isTTY && !guids.length && !bug) {
      console.warn("Loading blocklist...");
    }

    let [blockguids, blockregexes] = await this.kinto.loadBlocklist(bucket);

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

    data = data.map(id => id.trim());

    let type = detectIdType(data);
    switch (type) {
      case "id":
      case "slug": {
        console.warn(`Converting ${type}s to guids`);
        let result = await this.redash.queryMapIds(type, "guid", data);
        let found = new Set(Object.keys(result));
        let missing = data.filter(key => !found.has(key));
        if (missing.length) {
          console.warn(bold(`Could not find the following ${type}s:`));
          console.warn(missing.join("\n"));
          console.log("");
        }

        data = Object.values(result);
        break;
      }
      case "mixed":
        console.error("The ids passed could not be clearly identified. Are these all exclusively guids or ids?");
        return;
    }

    let alluserguids = await this.redash.queryAddonsInvolvedAccounts(data);
    let currentguidset = new Set(data);
    let otherguidset = new Set(alluserguids.filter(guid => !currentguidset.has(guid)));

    if (!allFromUsers && otherguidset.size > 0) {
      allFromUsers = (await waitForInput(`The users involved have ${otherguidset.size} more add-ons, also check them? [yN]`) == "y");
    }

    if (allFromUsers) {
      // Get other add-ons, lets make absolutely sure the original guids are contained
      data = [...new Set([...alluserguids, ...currentguidset])];
    }

    let { existing, newguids } = this.readGuidData(data, blockguids, blockregexes);

    // Show existing guids for information
    if (existing.size) {
      console.log(bold("The following guids are already blocked:"));
      for (let [guid, entry] of existing.entries()) {
        console.log(`${guid} - ${entry.details.bug || "no bug"}`);
        otherguidset.delete(guid);
      }
      console.log("");
    }

    if (allFromUsers) {
      console.log(bold("The following add-ons were added because the user is involved:"));
      console.log([...otherguidset].join("\n"));
      console.log("");
    }

    let newguidvalues = [...newguids.values()];
    if (newguidvalues && newguidvalues.length > 0) {
      // Show legacy add-ons, add-ons without any signed files, and unknown/invalid guids
      let [webex, legacy, unsigned, invalid] = await this.redash.querySeparateLegacyAndUnsigned(newguidvalues);
      newguidvalues = webex;

      if (unsigned.length) {
        console.log(bold("The following guids do not have any signed files:"));
        console.log(unsigned.join("\n"));
      }

      if (legacy.length) {
        console.log(bold("The following guids are for legacy add-ons and will not be blocked:"));
        console.log(legacy.join("\n"));
      }

      if (invalid.length) {
        console.log(bold("Warning: the following guids are not in the database:"));
        console.log(invalid.join("\n"));
      }
    }

    console.log("");

    // Show a list of new guids that can be blocked
    if (newguidvalues.length > 0) {
      let usage = showUsage && await this.redash_telemetry.queryUsage(newguidvalues);

      console.log(bold("Here is a list of all guids not yet blocked:"));
      if (usage) {
        console.log(newguidvalues.map(guid => {
          let usageString = usage[guid] ? DECIMAL_FORMAT.format(usage[guid]) : "unknown";
          return `${guid} - ${usageString}`;
        }).join("\n"));
      } else {
        console.log(newguidvalues.join("\n"));
      }

      let totalUsers = usage ? Object.values(usage).reduce((acc, users) => users + acc, 0) : 0;
      if (totalUsers > 0) {
        console.log("\n" + bold("Total users: ") + DECIMAL_FORMAT.format(totalUsers));
      }

      if (create) {
        await this.createBlocklistEntryInteractively({ guids: newguidvalues, canContinue, bugData, selfsign });
      } else {
        console.log("");
        console.log(bold("Here is the list of guids for kinto:"));
        console.log(createGuidStrings(newguidvalues).join("\n"));
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
   * @param {object} options                    The options for this function.
   * @param {string[]} options.guids            The guid strings for the blocklist entry.
   * @param {boolean} options.canContinue       Also create the entry if there are work in progress items.
   * @param {BlocklistBugData} options.bugData  The data from the blocklist bug for names and reasons.
   * @param {boolean} options.selfsign          If true, signing will occur using the shared key.
   */
  async createBlocklistEntryInteractively({ guids, canContinue=false, bugData=null, selfsign=false }) {
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
        bugData = await this.parseBlocklistBug(bugid);
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
          reason.kinto = pluralForm(guids.length, reason.kinto);
          reason.bugzilla = pluralForm(guids.length, reason.bugzilla);
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

    let minVersion = "0";
    let maxVersion = "*";

    // Only prompt for version when not using a regex, this case is not very common.
    if (guids.length == 1) {
      minVersion = await waitForInput("Minimum version [0]:") || "0";
      maxVersion = await waitForInput("Maximum version [*]:") || "*";
    }

    let answer = await waitForValidInput("Ready to create the blocklist entry?", "yn");

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
        let description = this.compileDescription(name, versions, reason.bugzilla, guids, additionalInfo);


        if (this.bugzilla.readonly) {
          throw new Error("Bugzilla is set to read-only, cannot create bug");
        }

        bugid = await this.bugzilla.create({
          product: "Toolkit",
          component: "Blocklist Policy Requests",
          version: "unspecified",
          summary: "Extension block request: " + name,
          description: description,
          whiteboard: "[extension]",
          status: "ASSIGNED",
          type: "task",
          assigned_to: account.name,
          groups: ["blocklist-requests"]
        });

        console.log(`Created https://bugzilla.mozilla.org/show_bug.cgi?id=${bugid} for this entry`);
      }

      let blocks = createGuidStrings(guids);
      let logblockprefix = blocks.length > 1 ? "\t": "Blocklist entry created, see ";
      if (blocks.length > 1) {
        console.log(`Splitting guids into ${blocks.length} blocklist entries:`);
      }

      for (let guidstring of blocks) {
        let entry = await this.kinto.createBlocklistEntry(guidstring, bugid, name, reason.kinto, HARD_BLOCK, minVersion, maxVersion);
        console.log(`${logblockprefix}${this.kinto.remote_writer}/admin/#/buckets/staging/collections/addons/records/${entry.data.id}/attributes`);
      }

      if (selfsign) {
        await this.signBlocklist({ selfsign, selfreview: true });
      }

      let users = await this.redash.queryUsersForIds("guid", guids);
      console.log("The following users are involved with these add-ons:");
      console.log(users.map(user => `\t${user.user_id} (${user.username} - ${user.display_name})`).join("\n"));
      let shouldBan = await waitForInput("Should they be banned? [yN]");

      if (shouldBan == "y") {
        let usermodels = new DjangoUserModels(this.amo);
        await usermodels.ban(users.map(user => user.user_id));
      } else {
        console.log("Disabling add-on and files");
        let failedguids = await this.disableAddonAndFiles(guids);

        if (failedguids.length) {
          console.log("Could not disable the following add-ons:");
          console.log(failedguids.map(guid => "\t" + guid).join("\n"));
        } else {
          console.log("Done");
        }
      }
    } else {
      console.log("In case you decide to do so later, here are the guid regexes:");
      console.log(createGuidStrings(guids).join("\n"));
    }
  }

  async disableAddonAndFiles(guids) {
    let failedguids = [];
    let format = "Disabling add-ons [{bar}] {percentage}% | ETA: {eta_formatted} | {value}/{total}";
    let bar = new SingleBar({ format }, Presets.legacy);
    bar.start(guids.length, 0);

    for (let guid of guids) {
      let addonadmin = new AddonAdminPage(this.amo, guid);

      try {
        await addonadmin.ensureLoaded();
        if (addonadmin.status != ADDON_STATUS.DELETED) {
          addonadmin.status = ADDON_STATUS.DISABLED;
        }
        await addonadmin.disableAllFiles();
      } catch (e) {
        failedguids.push(guid);
      }
      bar.increment();
    }
    bar.stop();

    return failedguids;
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
