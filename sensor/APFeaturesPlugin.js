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
const fwapc = require('../net2/fwapc.js');
const Identity = require('../net2/Identity.js');
const Host = require('../net2/Host.js');
const NetworkProfile = require('../net2/NetworkProfile.js');

class APFeaturesPlugin extends Sensor {
  async run() {
    const policyHandlers = {
      "isolation": this.applyIsolation,
      "ssidPSK": this.applySSIDPSK,
    };
    for (const key of Object.keys(policyHandlers))
      extensionManager.registerExtension(key, this, {
        applyPolicy: policyHandlers[key]
      });
  }

  async applyIsolation(obj, ip, policy) {
    if (obj instanceof Tag) {
      const tag = obj;
      const tagUid = _.get(tag, ["o", "uid"]);
      if (!tagUid) {
        log.error(`uid is not found on Tag object`, obj);
        return;
      }
      await Tag.ensureCreateEnforcementEnv(tagUid);
      const tagDevSetName = Tag.getTagDeviceSetName(tagUid);
      const rule = new Rule("filter").chn("FW_FIREWALL_DEV_G_ISOLATION").mdl("conntrack", "--ctdir ORIGINAL").jmp("FW_PLAIN_DROP");
      const ruleLog = new Rule("filter").chn("FW_FIREWALL_DEV_G_ISOLATION").mdl("conntrack", "--ctdir ORIGINAL").jmp(`LOG --log-prefix "[FW_ADT]A=I G=${tagUid} "`);
  
      const ruleTx = rule.clone().set(tagDevSetName, "src,src").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst").set(tagDevSetName, "dst,dst", true);
      const ruleTxLog = ruleLog.clone().set(tagDevSetName, "src,src").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst").set(tagDevSetName, "dst,dst", true);
  
      const ruleRx = rule.clone().set(tagDevSetName, "dst,dst").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src").set(tagDevSetName, "src,src", true);
      const ruleRxLog = ruleLog.clone().set(tagDevSetName, "dst,dst").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src").set(tagDevSetName, "src,src", true);
  
      const ruleInternal = rule.clone().set(tagDevSetName, "src,src").set(tagDevSetName, "dst,dst");
      const ruleInternalLog = ruleLog.clone().set(tagDevSetName, "src,src").set(tagDevSetName, "dst,dst");
  
      const ruleTx6 = ruleTx.clone().fam(6);
      const ruleTxLog6 = ruleTxLog.clone().fam(6);
      const ruleRx6 = ruleRx.clone().fam(6);
      const ruleRxLog6 = ruleRxLog.clone().fam(6);
      const ruleInternal6 = ruleInternal.clone().fam(6);
      const ruleInternalLog6 = ruleInternalLog.clone().fam(6);
  
      const op = policy.external ? "-A" : "-D";
      const opInternal = policy.internal ? "-A" : "-D";
      
      // add LOG rule before DROP rule
      await ruleTxLog.exec(op).catch((err) => { });
      await ruleTx.exec(op).catch((err) => { });
      await ruleTxLog6.exec(op).catch((err) => { });
      await ruleTx6.exec(op).catch((err) => { });
      await ruleRxLog.exec(op).catch((err) => { });
      await ruleRx.exec(op).catch((err) => { });
      await ruleRxLog6.exec(op).catch((err) => { });
      await ruleRx6.exec(op).catch((err) => { });
      await ruleInternalLog.exec(opInternal).catch((err) => { });
      await ruleInternal.exec(opInternal).catch((err) => { });
      await ruleInternalLog6.exec(opInternal).catch((err) => { });
      await ruleInternal6.exec(opInternal).catch((err) => { });
  
      await fwapc.setGroup(tagUid, {config: {isolation: {internal: policy.internal || false, external: policy.external || false}}}).catch((err) => {});
    }

    if (obj instanceof NetworkProfile) {
      const uuid = obj.getUniqueId();
      await obj.constructor.ensureCreateEnforcementEnv(uuid);
      const set4Name = NetworkProfile.getNetIpsetName(uuid, 4);
      const set6Name = NetworkProfile.getNetIpsetName(uuid, 6);
      const rule = new Rule("filter").chn("FW_FIREWALL_NET_ISOLATION").mdl("conntrack", "--ctdir ORIGINAL").jmp("FW_PLAIN_DROP");
      const ruleLog = new Rule("filter").chn("FW_FIREWALL_NET_ISOLATION").mdl("conntrack", "--ctdir ORIGINAL").jmp(`LOG --log-prefix "[FW_ADT]A=I N=${uuid.substring(0, 8)} "`);

      const op = policy.external ? "-A" : "-D";
      const opInternal = policy.internal ? "-A" : "-D";

      for (const {fam, setName} of [{fam: 4, setName: set4Name}, {fam: 6, setName: set6Name}]) {
        const ruleTx = rule.clone().fam(fam).set(setName, "src,src").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst").set(setName, "dst,dst", true);
        const ruleTxLog = ruleLog.clone().fam(fam).set(setName, "src,src").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst").set(setName, "dst,dst", true);
        const ruleRx = rule.clone().fam(fam).set(setName, "dst,dst").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src").set(setName, "src,src", true);
        const ruleRxLog = ruleLog.clone().fam(fam).set(setName, "dst,dst").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src").set(setName, "src,src", true);
        const ruleInternal = rule.clone().fam(fam).set(setName, "src,src").set(setName, "dst,dst");
        const ruleInternalLog = ruleLog.clone().fam(fam).set(setName, "src,src").set(setName, "dst,dst");

        await ruleTxLog.exec(op).catch((err) => {});
        await ruleTx.exec(op).catch((err) => {});
        await ruleRxLog.exec(op).catch((err) => {});
        await ruleRx.exec(op).catch((err) => {});
        await ruleInternalLog.exec(opInternal).catch((err) => {});
        await ruleInternal.exec(opInternal).catch((err) => {});
      }
      // there is no ap level API for network isolation, directly set isolation in wifiNetworks in apc config instead
    }

    if (obj instanceof Host || obj instanceof Identity) {
      await obj.constructor.ensureCreateEnforcementEnv(obj.getUniqueId());
      const set4Name = obj instanceof Host ? Host.getDeviceSetName(obj.getUniqueId()) : obj.getEnforcementIPsetName(obj.getUniqueId(), 4);
      const set6Name = obj instanceof Host ? set4Name : obj.getEnforcementIPsetName(obj.getUniqueId(), 6);
      const rule = new Rule("filter").chn("FW_FIREWALL_DEV_ISOLATION").mdl("conntrack", "--ctdir ORIGINAL").jmp("FW_PLAIN_DROP");
      const ruleLog = new Rule("filter").chn("FW_FIREWALL_DEV_ISOLATION").mdl("conntrack", "--ctdir ORIGINAL").jmp(`LOG --log-prefix "[FW_ADT]A=I "`);

      const op = policy.external ? "-A" : "-D";

      for (const {fam, setName} of [{fam: 4, setName: set4Name}, {fam: 6, setName: set6Name}]) {
        const ruleTx = rule.clone().fam(fam).set(setName, "src,src").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst");
        const ruleTxLog = ruleLog.clone().fam(fam).set(setName, "src,src").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst");
        const ruleRx = rule.clone().fam(fam).set(setName, "dst,dst").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src");
        const ruleRxLog = ruleLog.clone().fam(fam).set(setName, "dst,dst").set(ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src");
        await ruleTxLog.exec(op).catch((err) => {});
        await ruleTx.exec(op).catch((err) => {});
        await ruleRxLog.exec(op).catch((err) => {});
        await ruleRx.exec(op).catch((err) => {});
      }
      if (obj instanceof Host)
        await fwapc.setDeviceAcl(obj.getUniqueId(), {isolation: policy.external ? true : false}).catch((err) => {});
    }
  }

  async applySSIDPSK(obj, ip, policy) {
    if (!obj instanceof Tag) {
      log.error(`${policyKeyName} is not supported on ${obj.constructor.name} object`);
      return;
    }
    const tag = obj;
    const tagUid = _.get(tag, ["o", "uid"]);
    if (!tagUid) {
      log.error(`uid is not found on Tag object`, obj);
      return;
    }
    // filter non-existent profile uuid
    
    const psks = policy.psks;
    if (_.isObject(psks)) {
      const apcConfig = await fwapc.getConfig();
      for (const uuid of Object.keys(psks)) {
        if (!_.has(apcConfig, ["profile", uuid])) {
          log.error(`${uuid} is not found in apc active config, ignore it`);
          delete psks[uuid];
        }
      }
    }
    const ssidConfig = {vlan: policy.vlan, psks};
    if (_.isEmpty(ssidConfig) || !_.has(ssidConfig, "vlan") || _.isEmpty(ssidConfig.psks))
      await fwapc.deleteGroup(tagUid, "ssid").catch((err) => {
        log.error(`Failed to delete fwapc ssid config on group ${tagUid}`, err.message);
      });
    else
      await fwapc.setGroup(tagUid, {config: {ssid: ssidConfig}}).catch((err) => {
        log.error(`Failed to set fwapc ssid config on group ${tagUid}`, err.message);
      });
  }
}

module.exports = APFeaturesPlugin;