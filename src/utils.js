/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2018-2019 */

import readline from "readline";
import fs from "fs";

import { REGEX_BLOCK_MAXLEN, REGEX_BLOCK_START, REGEX_BLOCK_END, REGEX_BLOCK_DELIM } from "./constants";

/*
 * The following code is from https://searchfox.org/mozilla-central/source/toolkit/mozapps/extensions/Blocklist.jsm
 */

// The whole ID should be surrounded by literal ().
// IDs may contain alphanumerics, _, -, {}, @ and a literal '.'
// They may also contain backslashes (needed to escape the {} and dot)
// We filter out backslash escape sequences (like `\w`) separately
// (see kEscapeSequences).
const kIdSubRegex =
  "\\([" +
  "\\\\" + // note: just a backslash, but between regex and string it needs escaping.
  "\\w .{}@-]+\\)";

// prettier-ignore
// Find regular expressions of the form:
// /^((id1)|(id2)|(id3)|...|(idN))$/
// The outer set of parens enclosing the entire list of IDs is optional.
const kIsMultipleIds = new RegExp(
  // Start with literal sequence /^(
  //  (the `(` is optional)
  "^/\\^\\(?" +
    // Then at least one ID in parens ().
    kIdSubRegex +
    // Followed by any number of IDs in () separated by pipes.
    // Note: using a non-capturing group because we don't care about the value.
    "(?:\\|" + kIdSubRegex + ")*" +
  // Finally, we need to end with literal sequence )$/
  //  (the leading `)` is optional like at the start)
  "\\)?\\$/$"
);

// Check for a backslash followed by anything other than a literal . or curlies
const kEscapeSequences = /\\[^.{}]/;

// Used to remove the following 3 things:
// leading literal /^(
//    plus an optional (
// any backslash
// trailing literal )$/
//    plus an optional ) before the )$/
const kRegExpRemovalRegExp = /^\/\^\(\(?|\\|\)\)?\$\/$/g;

/*
 * End code from Blocklist.jsm
 */


/**
 * Escape a string for use in the RegExp constructor.
 *
 * @param {string} str      The string to escape.
 * @return {string}         The escaped string.
 */
function regexEscape(str) {
  return str.replace(/[\\$^*+.?(){}|[\]]/g, "\\$&");
}

/**
 * Wait for input from stdin until Ctrl+D.
 *
 * @return {Promise<string[]>}      An array with the lines from stdin.
 */
export function waitForStdin() {
  return new Promise((resolve) => {
    let lines = [];
    let rli = readline.createInterface({ input: process.stdin, });

    rli.on("line", line => lines.push(line));
    rli.once("close", () => {
      resolve(lines);
    });
  });
}

/**
 * Wait for input on a question on stdin. The input will be trimmed.
 *
 * @param {string} prompt               The prompt to show.
 * @param {boolean} [lowercase=true]    If the result should be made lowercase.
 * @return {Promise<string>}            The string result with the answer.
 */
export function waitForInput(prompt, lowercase=true) {
  return new Promise((resolve, reject) => {
    if (process.platform == "win32") {
      // win32 does not have /dev/tty. We need to find an alternative way to read from the terminal
      // regardless of what stdin is connected to.
      reject("Temporarily, win32 is not supported. You're going to have to fix this on your own :)");
      return;
    }

    let stdin = fs.createReadStream("/dev/tty");

    let rli = readline.createInterface({
      input: stdin,
      output: process.stdout
    });

    rli.question(prompt + " ", (answer) => {
      rli.close();
      stdin.close();

      if (lowercase) {
        answer = answer.toLowerCase();
      }
      resolve(answer.trim());
    });
  });
}


/**
 * Wait for input on a question on stdin, validating the response. The input will be trimmed.
 *
 * @param {string} prompt               The prompt to show.
 * @param {string} valid                Valid characters for the reply, e.g. "yn".
 * @param {boolean} [lowercase=true]    If the result should be made lowercase.
 * @return {Promise<string>}            The string result with the answer.
 */
export async function waitForValidInput(prompt, valid, lowercase=true) {
  let answer;
  while (true) {
    answer = await waitForInput(prompt + ` [${valid}]`, lowercase);

    if (answer.length == 1 && valid.toLowerCase().indexOf(answer.toLowerCase()) > -1) {
      break;
    } else {
      console.log(`Expected [${valid}], got ${answer}`);
    }
  }
  return answer;
}

/**
 * Make the text bold for output on the terminal.
 *
 * @param {string} text     The string to make bold.
 * @return {string}         The bold text.
 */
export function bold(text) {
  return `\x1b[1m${text}\x1b[0m`;
}

/**
 * Make the text colored in some way.
 *
 * @param {string} color    Color constant, e.g. Colored.RED.
 * @param {string} text     The string to color.
 * @return {string}         The colored text.
 */
export function colored(color, text) {
  return `\x1b[0;${color}m${text}\x1b[0m`;
}
colored.RESET = 0;
colored.BLACK = 30;
colored.RED = 31;
colored.GREEN = 32;
colored.YELLOW = 33;
colored.BLUE = 34;
colored.MAGENTA = 35;
colored.CYAN = 36;


export class CaselessMap extends Map {
  constructor(iterable) {
    let data = [];
    for (let [key, value] of iterable) {
      data.push([key.toLowerCase(), value]);
    }

    super(data);
  }

  has(key) {
    return super.has(key.toLowerCase());
  }

  set(key, value) {
    return super.set(key.toLowerCase(), value);
  }

  get(key) {
    return super.get(key.toLowerCase());
  }
}

/**
 * Get the severity string based on the constant.
 *
 * @param {number} severity     The severity constant.
 * @return {string}             The severity string.
 */
export function getSeverity(severity) {
  let map = { 1: "soft", 3: "hard" };
  return map[severity] || `unknown (${severity})`;
}

/**
 * Create kinto guid strings, up to the maximum length we support since bug 1604655. For a single
 * guid this will be an array with just the guid.
 *
 * @param {string[]} guids      The array of guids.
 * @return {string[]}           The array of compiled guid strings.
 */
export function createGuidStrings(guids) {
  if (guids.length > 1) {
    let blocks = [];
    let current = [];
    let curlen = 0;
    let overhead = REGEX_BLOCK_DELIM.length;

    for (let guid of guids) {
      let escaped = regexEscape(guid);
      curlen += escaped.length + overhead;

      if (curlen > REGEX_BLOCK_MAXLEN) {
        blocks.push(current);
        current = [];
        curlen = escaped.length + overhead;
      }
      current.push(escaped);
    }
    blocks.push(current);

    return blocks.map(block => {
      return REGEX_BLOCK_START +
        block.join(REGEX_BLOCK_DELIM) +
        REGEX_BLOCK_END;
    });
  } else {
    return [guids[0]];
  }
}

/**
 * Extracts guids from the regex we commonly use for blocks.
 *
 * @param {string} str        The regex string to expand.
 * @return {string[]}         The expanded guids.
 */
export function expandGuidRegex(str) {
  if (!str.startsWith("/")) {
    return [str];
  }

  if (kIsMultipleIds.test(str) && !kEscapeSequences.test(str)) {
    // Remove the regexp gunk at the start and end of the string, as well
    // as all backslashes, and split by )|( to leave the list of IDs.
    return [...new Set(str.replace(kRegExpRemovalRegExp, "").split(")|("))];
  } else {
    return [];
  }
}

/**
 * Expand a string into the correct plural form. Only support for plural rule 1, which
 * includes English.
 *
 * @param {number} count        The number of items to expand for.
 * @param {string} str          The semicolon separated string with the plural rule.
 * @return {string}             The correct string part based on the number.
 */
export function pluralForm(count, str) {
  // We are only using English anyway, so taking the shortcut
  let parts = str.split(";");
  return count == 1 || parts.length < 2 ? parts[0]: parts[1];
}
