/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2018 */

var readline = require("readline");

/**
 * Escape a string for use in the RegExp constructor.
 *
 * @param {String} str      The string to escape
 * @return {String}         The escaped string
 */
function regexEscape(str) {
  return str.replace(/[\\$^*+.?(){}|[\]]/g, "\\$&");
}

/**
 * Wait for input from stdin until Ctrl+D
 *
 * @return {Promise<String[]>}      An array with the lines from stdin
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
 * @param {String} prompt       The prompt to show
 * @param {Boolean} lowercase   If the result should be made lowercase
 * @return {Promise<String>}    The string result with the answer
 */
function waitForInput(prompt, lowercase=true) {
  return new Promise((resolve) => {
    let rli = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rli.question(prompt, (answer) => {
      rli.close();
      if (lowercase) {
        answer = answer.toLowerCase();
      }
      resolve(answer.trim());
    });
  });
}

/**
 * Make the text bold for output on the terminal
 *
 * @param {String} text     The string to make bold
 * @return {String}         The bold text
 */
function bold(text) {
  return `\x1b[1m${text}\x1b[0m`;
}

module.exports = { regexEscape, waitForStdin, waitForInput, bold };
