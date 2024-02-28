/*    Copyright 2021 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict'

const {spawn} = require('child_process');
const log = require('../net2/logger.js')(__filename);
const readline = require('readline');

class Tail {
  constructor(file, sudo = false, delayMs = 0) {
    this.file = file;
    this.sudo = sudo;
    this.delayMs = delayMs;
  }

  on(event, callback) {
    switch(event) {
    case "line":
      this.lineCallback = callback;
      break;
    }
  }

  watch() {
    log.info("Watching file", this.file);
    const cmd = this.sudo ? "sudo" : "tail";
    const args = this.sudo ? ["tail", "-F", this.file, "-n", "0"] : ["-F", this.file, "-n", "0"];

    const source = spawn(cmd, args,
                         { stdio: ['ignore', 'pipe', 'ignore'] }
                        );

    const reader = readline.createInterface({ input: source.stdout });

    reader.on('line', async (line) => {
      if (this.lineCallback) {
        if (this.delayMs) {
          setTimeout(async () => {
            try {
              await this.lineCallback(line);
            } catch (err) {
              log.error(`Failed to process line: ${line}`, err);
            }
          }, this.delayMs);
        } else {
          try {
            // it still works if this is a non-async callback, but without callstack
            await this.lineCallback(line);
          } catch (err) {
            log.error(`Failed to process line: ${line}`, err)
          }
        }
      }
    });

    source.on('close', (code) => {
      log.error("Watching file ended, should not happen in production");
    });

    source.on('error', (err) => {
      log.error("Got error when tailing file", this.file, "err:", err);
    });
  }
}

module.exports = Tail;
