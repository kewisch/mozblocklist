/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2018-2019 */

import yargs from "yargs";
import { AMOSession, AMORedashClient, TelemetryRedashClient, BMOClient, requiresVPN, getConfig } from "amolib";
import { UserSheet } from "./sheet";

import BlocklistKintoClient from "./kinto-client";
import { KintoBasicAuth, KintoOAuth, KeytarAuthStore } from "./kinto-auth";
import Mozblocklist from "./mozblocklist";
import { PUBLIC_HOST, PROD_HOST, STAGE_HOST } from "./constants";
import { CaselessMap, waitForStdin } from "./utils";

import path from "path";
import os from "os";

/**
 * The main program executed when called.
 */
(async function() {
  process.stdin.setEncoding("utf8");

  /**
   * The yargs handler function for the check and create commands. The type argument should be bound.
   *
   * @param {string} type       The type of command (check/create).
   * @param {object} subyargs   The yargs object.
   */
  function checkCreateCommand(type, subyargs) {
    subyargs.positional("guids", {
      describe: `The add-ons guids to ${type}`,
      type: "string",
    })
      .default("guids", [], "<from stdin>")
      .option("c", {
        "alias": "continue",
        "boolean": true,
        "describe": "Allow creation when there are work in progress items"
      })
      .option("B", {
        alias: "bug",
        describe: type + " blocks from given bug"
      })
      .options("u", {
        "alias": "usage",
        "boolean": true,
        "describe": "Show usage information"
      })
      .option("U", {
        "alias": "user",
        "boolean": true,
        "describe": "Include all add-ons by involved users"
      });
  }

  let config = getConfig();

  let argv = yargs
    .option("bugzilla", {
      "boolean": true,
      "default": true,
      "describe": "Enable bugzilla commenting"
    })
    .option("debug", {
      "boolean": true,
      "describe": "Enable debugging"
    })
    .option("H", {
      "alias": "host",
      "default": PUBLIC_HOST,
      "describe": "The kinto host to access"
    })
    .option("W", {
      alias: "writer",
      conflicts: "stage",
      // Can't have a real default here because it will conflict with the stage option
      describe: `The writer instance of kinto to use.                      [default: "${PROD_HOST}"]`
    })
    .option("s", {
      "alias": "stage",
      "boolean": true,
      "conflicts": "writer",
      "describe": "Use the stage writer instead of the production writer"
    })
    .command("check [guids..]", "Find out what entries already exist in the blocklist", (subyargs) => {
      checkCreateCommand("check", subyargs);
      subyargs.option("b", {
        "alias": "bucket",
        "default": "blocklists",
        "choices": ["blocklists", "blocklists-preview", "staging"],
        "describe": "The bucket to compare against."
      });
    })
    .command("create [guids..]", "Stage a block for a set of guids", (subyargs) => {
      checkCreateCommand("create", subyargs);

      subyargs.option("S", {
        "alias": "selfsign",
        "boolean": true,
        "describe": "Self-sign the entry using the shared key"
      })
        .option("b", {
          "alias": "bucket",
          "default": "staging",
          "choices": ["blocklists", "blocklists-preview", "staging"],
          "describe": "The bucket to compare against."
        });
    })
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
        .option("b", {
          "alias": "bucket",
          "default": "blocklists",
          "choices": ["blocklists", "blocklists-preview", "staging"],
          "describe": "The bucket to display"
        })
        .epilog(
          "The 'json' output will show the raw blocklist.\n\n" +
        "The 'sql' output will take a list of guids on stdin (or use the -a option) and show SQL" +
        " statements to create a table out of them. This is useful for further processing on redash."
        );
    })
    .command("usage [guids...]", "Show usage for a number of add-ons", (subyargs) => {
      subyargs.positional("guids", {
        describe: "The add-ons guids to get usage info for",
        type: "string",
      })
        .default("guids", [], "<from stdin>");
    })
    .command("status", "Check the current blocklist status")
    .command("review", "Request review for pending blocklist entries", (subyargs) => {
      subyargs.option("r", {
        "alias": "reviewer",
        "type": "array",
        "default": [],
        "coerce": (reviewer) => {
          if (reviewer.length == 1) {
            let caseMap = new CaselessMap(Object.entries(config.mozblocklist.reviewers || {}));
            let reviewerData = caseMap.get(reviewer[0]);
            if (reviewerData) {
              return [reviewerData.name, reviewerData.email];
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
      })
        .options("u", {
          "alias": "usage",
          "boolean": true,
          "describe": "Show usage information"
        });
    })
    .command("pending", "Show blocklist entries pending for signature", (subyargs) => {
      subyargs.option("w", {
        "alias": "wip",
        "boolean": true,
        "describe": "Show work in progress items instead of those pending review"
      })
        .option("g", {
          "alias": "guids",
          "boolean": true,
          "describe": "Show pending guids instead of the full block"
        });
    })
    .command("sign", "Sign pending blocklist entries after verification", (subyargs) => {
      subyargs.option("S", {
        "alias": "selfsign",
        "boolean": true,
        "describe": "Self-sign the entry using the shared key"
      })
        .options("u", {
          "alias": "usage",
          "boolean": true,
          "describe": "Show usage information",
          // Signing with user sheet requires usage info
          "default": !!(config.mozblocklist && config.mozblocklist.userSheet),
        });
    })
    .command("reject", "Reject a pending blocklist review")
    .example("echo guid@example.com | $0 check", "Check if guid@example.com is in the blocklist")
    .example("echo 1285960 | $0 check -i", "The same, but check for the AMO id of the add-on")
    .example("echo 1285960 | $0 create -i", "The same, but also prompt for creating the blocklist entry")
    .example("$0 check", "Interactively enter a list of guids to check in the blocklist")
    .demandCommand(1, 1, "Error: Missing required command")
    .config((config && config.mozblocklist && config.mozblocklist.defaults) || {})
    .wrap(120)
    .argv;

  let writer;
  let remote;
  if (argv.stage) {
    writer = `https://${STAGE_HOST}/v1`;
    remote = `https://${STAGE_HOST}/v1`;
  } else {
    writer = `https://${argv.writer || PROD_HOST}/v1`;
    remote = `https://${argv.host}/v1`;
  }

  let userSheetConfig = config.mozblocklist && config.mozblocklist.userSheet || {}; // eslint-disable-line no-mixed-operators

  let mozblock = new Mozblocklist({
    globalOpts: argv,
    kinto: new BlocklistKintoClient(remote, {
      writer: writer,
      auth: new KintoOAuth(new KeytarAuthStore("mozblocklist", "oauth")),
    }),
    kintoapprover: new BlocklistKintoClient(remote, {
      writer: writer,
      auth: new KintoBasicAuth(new KeytarAuthStore("mozblocklist", "basic")),
    }),
    bugzilla: new BMOClient(config.auth && config.auth.bugzilla_key, !argv.bugzilla),
    redash: new AMORedashClient({ apiToken: config.auth && config.auth.redash_key, debug: argv.debug }),
    redash_telemetry: new TelemetryRedashClient({ apiToken: config.auth && config.auth.redash_key, debug: argv.debug }),
    amo: new AMOSession({ debug: argv.debug }),
    usersheet: new UserSheet({
      sheetId: userSheetConfig.sheetId,
      sheetRange: userSheetConfig.sheetRange,
      credentials: userSheetConfig.credentials,
      authstore: new KeytarAuthStore("mozblocklist", "gsheets"),
      debug: argv.debug
    })
  });

  try {
    // TODO move this to keytar
    mozblock.amo.loadCookies(path.join(os.homedir(), ".amo_cookie"));
  } catch (e) {
    // This can fail if the file doesn't exist or the data is invalid, which is fine.
  }

  switch (argv._[0]) {
    case "list":
      await mozblock.displayBlocklist(argv.format, argv.all || false, argv.bucket);
      break;

    case "create":
      requiresVPN();
      // Fallthrough intended
    case "check":
      await mozblock.checkGuidsInteractively({
        create: argv._[0] == "create",
        canContinue: !!argv["continue"],
        guids: argv.guids || [],
        bug: argv.bug,
        showUsage: argv.usage,
        allFromUsers: argv.user,
        selfsign: argv.selfsign,
        bucket: argv.bucket
      });
      break;

    case "pending":
      requiresVPN();
      if (argv.guids) {
        await mozblock.displayPendingGuids(argv.wip ? "staging" : "blocklists-preview");
      } else {
        await mozblock.displayPending({ compareWith: argv.wip ? "staging" : "blocklists-preview" });
      }
      break;

    case "status":
      requiresVPN();
      await mozblock.printBlocklistStatus();
      break;
    case "review":
      await mozblock.reviewBlocklist({
        reviewerName: argv.reviewer[0],
        reviewerEmail:  argv.reviewer[1],
        showUsage: argv.usage
      });
      break;
    case "usage":
      if (!argv.guids.length) {
        if (process.stdin.isTTY) {
          console.warn("Waiting for guids (one per line, Ctrl+D to finish)");
        }
        argv.guids = await waitForStdin();
      }

      await mozblock.showUsage(argv.guids);
      break;
    case "sign":
      await mozblock.reviewAndSignBlocklist({ selfsign: argv.selfsign, showUsage: argv.usage });
      break;
    case "test":
      break;
    case "reject":
      await mozblock.kinto.rejectBlocklist();
      break;
    default:
      yargs.showHelp();
      break;
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
