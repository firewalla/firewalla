/*    Copyright 2016-2024 Firewalla Inc.
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

const Sensor = require('./Sensor.js').Sensor;
const _ = require('lodash');
const policyKeyName = "isolation";
const extensionManager = require('./ExtensionManager.js');
const Tag = require('../net2/Tag.js');
const { Rule } = require('../net2/Iptables.js');
const ipset = require('../net2/Ipset.js');
const Constants = require('../net2/Constants.js');
const exec = require('child-process-promise').exec;

class IsolationSensor extends Sensor {
  async run() {
    extensionManager.registerExtension(policyKeyName, this, {
      applyPolicy: this.applyPolicy
    });
  }

  async applyPolicy(obj, ip, policy) {
    if (obj.constructor.name !== "Tag") {
      log.error(`${policyKeyName} is not supported on ${obj.constructor.name} object`);
      return;
    }
    const tag = obj;
    const tagUid = _.get(tag, ["o", "uid"]);
    if (!tagUid) {
      log.error(`uid is not found on Tag object`, obj);
      return;
    }
    const tagDevSetName = Tag.getTagDeviceSetName(tagUid);
    const rule = new Rule("filter").chn("FW_FIREWALL_DEV_G_ISOLATION").mdl("conntrack", "--ctdir ORIGINAL").jmp("FW_PLAIN_DROP");
    const ruleLog = new Rule("filter").chn("FW_FIREWALL_DEV_G_ISOLATION").mdl("conntrack", "--ctdir ORIGINAL").jmp(`LOG --log-prefix "[FW_ADT]A=I G=${tagUid} "`);

    const ruleTx = rule.clone().set(tagDevSetName, "src,src").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst").set(tagDevSetName, "dst,dst", true);
    const ruleTxLog = ruleLog.clone().set(tagDevSetName, "src,src").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst").set(tagDevSetName, "dst,dst", true);

    const ruleRx = rule.clone().set(tagDevSetName, "dst,dst").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src").set(tagDevSetName, "src,src", true);
    const ruleRxLog = ruleLog.clone().set(tagDevSetName, "dst,dst").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src").set(tagDevSetName, "src,src", true);

    const ruleTx6 = ruleTx.clone().fam(6);
    const ruleTxLog6 = ruleTxLog.clone().fam(6);
    const ruleRx6 = ruleRx.clone().fam(6);
    const ruleRxLog6 = ruleRxLog.clone().fam(6);

    let op;
    if (policy && policy.state === true) {
      op = "-A";
    } else {
      op = "-D";
    }
    // add LOG rule before DROP rule
    await ruleTxLog.exec(op).catch((err) => { });
    await ruleTx.exec(op).catch((err) => { });
    await ruleTxLog6.exec(op).catch((err) => { });
    await ruleTx6.exec(op).catch((err) => { });
    await ruleRxLog.exec(op).catch((err) => { });
    await ruleRx.exec(op).catch((err) => { });
    await ruleRxLog6.exec(op).catch((err) => { });
    await ruleRx6.exec(op).catch((err) => { });
  }
}

module.exports = IsolationSensor;