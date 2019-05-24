/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2018-2019 */

import readline from "readline";
import fs from "fs";

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
 * Make the text bold for output on the terminal.
 *
 * @param {string} text     The string to make bold.
 * @return {string}         The bold text.
 */
export function bold(text) {
  return `\x1b[1m${text}\x1b[0m`;
}


export class CaselessMap extends Map {
  constructor(iterable) {
    let data = [];
    for (let [k, v] of iterable) {
      data.push([k.toLowerCase(), v]);
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
 * Create the kinto guid string, so string with regex or a simple uuid.
 *
 * @param {string[]} guids      The array of guids.
 * @return {string}             The compiled guid string.
 */
export function createGuidString(guids) {
  if (guids.length > 1) {
    return "/^((" + guids.map(regexEscape).join(")|(") + "))$/";
  } else {
    return guids[0];
  }
}
