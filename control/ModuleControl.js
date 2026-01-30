/*    Copyright 2026 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename);

const sem = require('../sensor/SensorEventManager.js').getInstance();

// wraps a linux tool that we use to implement rules, ipset, iptables, dnsmasq, etc
class ModuleControl {
  constructor(name) {
    this.name = name;
  }

  addRule(rule) {
    // Emit in-process event via SensorEventManager (no Redis for same-process events)
    sem.sendEventToFireMain({
      type: 'Control:RuleAdded',
      moduleName: this.name,
      rule,
      suppressEventLogging: true,
    });
  }

  
}

module.exports = ModuleControl;