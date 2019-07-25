/*    Copyright 2016 Firewalla LLC
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

let instance = null;
let log = require("../../net2/logger.js")(__filename);

let exec = require('child-process-promise').exec;

let util = require('util');

class Samba {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    return instance;
  }

  async getSambaName(ip) {
    let cmd = util.format("nbtscan -e %s | head -n 1 | awk '{print $2}'", ip);
    log.info("Running command:", cmd);

    let exists = await this.nbtscanExists()
    if (!exists)
      return undefined; // empty string means not having samba name or not supported

    let result = await exec(cmd)

    if (!result.stdout) {
      return undefined;
    }

    let output = result.stdout
    output = output.trim()

    if (output === '<unknown>') {
      return undefined
    } else {
      return output
    }
  }

  nbtscanExists() {
    return exec("which nbtscan")
      .then(() => {
        return true;
      }).catch((err) => {
        return false;
      })
  }
}

module.exports = Samba;
