/*    Copyright 2016-2021 Firewalla Inc.
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

const config = require('../net2/config.js').getConfig();

const intels = [];
const intelsHash = {}

function initIntels() {
  let intelConfigs = config.intels;

  if(!intelConfigs)
    return;

  intelConfigs.forEach((intelName) => {
    try {
      log.info(`Loading Intel ${intelName}`);

      let fp = './' + intelName + '.js';
      let s = require(fp);
      let ss = new s();

      intels.push(ss);
      intelsHash[intelName] = ss
    } catch(err) {
      log.error(`Failed to load intel: ${intelName}: ${err}`)
    }
  });
}

async function enrichAlarm(alarm) {

  for (let i = 0; i < intels.length; i++) {
    const intel = intels[i];
    alarm = await intel.enrichAlarm(alarm).catch((err) => {
      log.warn(`Failed to enrich alarm with intel ${intel.getName()}, err: ${err}`);
      return alarm;
    });

    if(alarm && alarm["p.local.decision"] == "ignore") {
      break;
    }
  }

  return alarm;
}

function getIntel(name) {
  return intelsHash[name]
}

initIntels();

module.exports = {
  initIntels:initIntels,
  enrichAlarm:enrichAlarm,
  getIntel: getIntel
};
