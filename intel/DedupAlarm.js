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

const log = require('../net2/logger.js')(__filename);

const Intel = require('./Intel.js');

class DedupAlarm extends Intel {

  async enrichAlarm(alarm) {

    const AM2 = require('../alarm/AlarmManager2.js');
    const am2 = new AM2();

    const result = await am2.dedup(alarm).catch((err) => {
      log.error("Failed to dedup, err:", err);
      return true;
    });

    if(result) { // should ignore
      alarm["p.local.decision"] = "ignore";
    }

    return alarm;
  }

}

module.exports = DedupAlarm;
