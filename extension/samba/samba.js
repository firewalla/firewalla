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

let async = require('asyncawait/async');
let await = require('asyncawait/await');

class Samba {
  constructor() {
    if (instance == null) {
        instance = this;
    }
    return instance;
  }

  getSambaName(ip) {
    let cmd = util.format("nbtscan -s / %s", ip);
    log.info("Running command:", cmd, {});

    return async(() => {
      let exists = await (this.nbtscanExists());
      if(!exists)
        return undefined; // empty string means not having samba name or not supported

      let result = await (exec(cmd));
      if(result.stdout) {
        let outputs = result.stdout.split("/");
        if(outputs.length >= 2) {
          return outputs[1];
        } else {
          log.error("Invalid nbtscan output:", result.stdout, {});
          return undefined;
        }
      } else {
        log.error("Invalid nbtscan output:", result.stderr, {});
        return undefined;
      }
    })();
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
