/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2018 */

var readline = require("readline");
var fs = require("fs");

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
function waitForStdin() {
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
 * @param {boolean} [realStdin=true]    Input from the terminal, not the pipe connected to stdin.
 * @return {Promise<string>}            The string result with the answer.
 */
function waitForInput(prompt, lowercase=true, realStdin=true) {
  return new Promise((resolve, reject) => {
    let stdin = realStdin && !process.stdin.isTTY ? fs.createReadStream("/dev/tty") : process.stdin;

    if (realStdin && !process.stdin.isTTY && process.platform == "win32") {
      reject("Windows doesn't support /dev/tty, please don't use pipes for this operation");
      return;
    }

    let rli = readline.createInterface({
      input: stdin,
      output: process.stdout
    });

    rli.question(prompt + " ", (answer) => {
      rli.close();
      if (realStdin && !process.stdin.isTTY) {
        stdin.close();
      }

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
function bold(text) {
  return `\x1b[1m${text}\x1b[0m`;
}

module.exports = { regexEscape, waitForStdin, waitForInput, bold };
