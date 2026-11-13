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
const Message = require('../net2/Message.js');

const _ = require('lodash');

// wraps a linux tool that we use to implement rules, ipset, iptables, dnsmasq, etc
class ModuleControl {
  constructor(name) {
    this.name = name;
    this.phase = 'init';

    sem.on(Message.MSG_DEBUG, event => {
      if (event.name == this.constructor.name) {
        if (event.data == 'state') {
          log.info('Current state:', _.get(this, event.path))
        }
      }
    })

  }

  setPhase(phase) {
    this.phase = phase;
  }

  // what addRule appends to in the init phase; a module with another queue shape overrides it
  emptyQueue() {
    return [];
  }

  // the batch of one processing round. BlockControl takes every module's queue before the round
  // starts, so a rule enqueued during the round waits for the next one together with the sets it names
  takeQueue() {
    const queued = this.queuedRules;
    this.queuedRules = this.emptyQueue();
    return queued;
  }

  addRule(rule) {
    // Emit in-process event via SensorEventManager (no Redis for same-process events)
    sem.sendEventToFireMain({
      type: 'Control:RuleAdded',
      module: this.name,
      rule,
      suppressEventLogging: true,
    });
  }

  
}

module.exports = ModuleControl;