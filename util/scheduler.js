/*    Copyright 2021 Firewalla INC
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

'use strict';
const log = require('../net2/logger.js')(__filename);
const _ = require('lodash');

function delay(t) {
  return new Promise(function (resolve) {
    setTimeout(resolve, t);
  });
}

// This class wraps an async function/method. Once in execution, if it's executed again in parallel, the wrapped async function will not be run simultaneously. Instead it will be scheduled to run later. This can be useful in multiple successive update operation as it reduce the amount of operation actually run.
class UpdateJob {
  constructor(f, intervalMillis = 0) {
    this.f = f;
    this._running = false;
    this._scheduleArgsList = [];
    this.intervalMillis = intervalMillis;
  }

  async exec(...args) {
    const len = this._scheduleArgsList.length;
    // if the same job has been scheduled to run last. Skip adding it.
    if (len && _.isEqual(args, this._scheduleArgsList[len - 1])) {
      return;
    }
    this._scheduleArgsList.push(args);
    log.debug(`Schedule ${this.f.name} with args: ${args}`);

    if (this._running === true) {
      log.debug(`function ${this.f.name} is running.`);
    } else {
      this._running = true;
      while (true) {
        if (this.intervalMillis !== 0) {
          await delay(this.intervalMillis);
        }
        const nextRunArgs = this._scheduleArgsList.shift();
        try {
          await (this.f)(...nextRunArgs);
        } catch (e) {
          log.error(e);
        }
        if (this._scheduleArgsList.length !== 0) {
          continue;
        } else {
          break;
        }
      }
      this._running = false;
    }

  }

}

module.exports = {
  UpdateJob,
  delay
};