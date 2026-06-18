/*    Copyright 2016-2026 Firewalla Inc.
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

const _ = require('lodash');
const log = require("../net2/logger.js")(__filename);
const { Rule } = require('../net2/Iptables.js');
const iptc = require('../control/IptablesControl.js');
const domainBlock = require('../control/DomainBlock.js');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();
const Constants = require('../net2/Constants.js');

const initializedBypassChain = {};

async function ensureCreateBypassChain(table, pid) {
  const bypassChain = `FW_${pid}_BYPASS`;
  const key = `${table}_${bypassChain}`;
  if (initializedBypassChain[key]) {
    return ;
  }
  for (const family of [4, 6]) {
    const rule = new Rule(table).fam(family).chn(bypassChain).opr('-N');
    await iptc.addRule(rule);
  }
  initializedBypassChain[key] = 1;
}

async function removeBypassChain(table, pid) {
  const bypassChain = `FW_${pid}_BYPASS`;
  const key = `${table}_${bypassChain}`;
  if (!initializedBypassChain[key]) {
    return ;
  }
  for (const family of [4, 6]) {
    const rule = new Rule(table).fam(family).chn(bypassChain).opr('-F');
    await iptc.addRule(rule);
    await iptc.addRule(rule.opr('-X'));
  }
  delete initializedBypassChain[key];
}

function isBypassChainExist(table, pid) {
  const bypassChain = `FW_${pid}_BYPASS`;
  const key = `${table}_${bypassChain}`;
  if (initializedBypassChain[key]) {
    return true;
  }
  return false;
}


async function bypassDNSRules(options) {

  const {affectedPids, tags, intfs, scope, guids, action, pid, targets, type} = options;
  const PolicyManager2 = require('../alarm/PolicyManager2.js');
  const CategoryUpdater = require('../control/CategoryUpdater.js');
  const categoryUpdater = new CategoryUpdater();
  const pm2 = new PolicyManager2();
  let shouldAppend = false;
  let restartDNS = false;
  const categoryMap = new Map(); // key: category${seqHigh}, value: {category, seq}

  for (const aPid of affectedPids) {
    const policy = await pm2.getPolicy(aPid);
    if (!policy) {
      log.warn(`Failed to ${action} bypass policy ${pid} for affected policy ${aPid} as it doesn't exist`);
      continue;
    }
    if (type == "category") {
      const categories = policy.targets || [policy.target];
      for (let category of categories) {
        if (policy.useBf) {
          category = categoryUpdater.getBfCategoryName(category);
        }
        const key = `${category}${policy.seq == Constants.RULE_SEQ_HI ? 'Hi' : 'Normal'}`;
        if (!categoryMap.has(key)) {
          categoryMap.set(key, {category, seq: policy.seq});
        }
      }
    } else {
      // if type is not category, need add bypass entries for each affected policy
      // for bypass device: mac-address-tag=%${mac}$!policy_${options.apid}&${options.pid}
      // for bypass intfs: mac-address-tag=%00:00:00:00:00:00$!policy_${options.apid}&${options.pid}
      // for bypass tags: group-tag=@${tag}$!policy_${options.apid}&${options.pid}
      // for bypass guid: group-tag=@${identityClass.getEnforcementDnsmasqGroupId(uid)}$!policy_${options.apid}&${options.pid}
      if (action == "enforce") {
        await dnsmasq.addPolicyFilterEntry([policy.target], { pid, scope, intfs, tags, guids, action: "bypass", aPid,
          append: shouldAppend}).catch(err => {
          log.error(`Failed to add policy filter entry for ${pid} when processing affected policy ${aPid}: ${err}`);
        });
      }
      shouldAppend = true;
      restartDNS = true;
    }
  }

  // bypass dnsmasq rules
  if (action == "enforce") {
    if (type === "category") { // other type already handled in the loop above
      for (const {category, seq} of categoryMap.values()) {
        await dnsmasq.addPolicyCategoryFilterEntry({
          pid: pid,
          categories: [category],
          action: "bypass",
          tags: tags,
          scope: scope,
          guids: guids,
          intfs: intfs,
          seq: seq,
          append: shouldAppend
        }).catch(err => {
          log.error(`Failed to add policy category filter entry for ${pid} and category ${category}: ${err}`);
        });
        shouldAppend = true;
        restartDNS = true;
      }
    }
  } else if (action == "unenforce") {
    if (type === "category") {
      await dnsmasq.removePolicyCategoryFilterEntry({
        pid: pid,
        categories: targets,
        action: "bypass",
        tags: tags,
        scope: scope,
        guids: guids,
        intfs: intfs
      }).catch(err => {
        log.error(`Failed to remove policy category filter entry for ${pid} and category ${targets}: ${err}`);
      });
    } else {
      await dnsmasq.removePolicyFilterEntry(targets, {
        pid: pid,
        scope, intfs, tags, guids, action: "bypass"
      }).catch(err => {
        log.error(`Failed to remove policy filter entry for ${pid} when processing affected policies ${affectedPids}: ${err}`);
      });
    }
    restartDNS = true;
  }
  
  if (restartDNS) {
    await dnsmasq.scheduleRestartDNSService();
  }
}

async function bypassIptablesRules(options) {
  const {affectedPids, tags, intfs, action, pid, targets, scope, guids, type} = options;
  const PolicyManager2 = require('../alarm/PolicyManager2.js');
  const pm2 = new PolicyManager2();
  const categoriesWithBfSet = new Set();
  const PolicyDisturbManager = require('../alarm/PolicyDisturbManager.js');

  // try to inject exception to all affected policies
  for (const aPid of affectedPids) {
    const policy = await pm2.getPolicy(aPid);
    if (!policy) {
      log.warn(`Failed to ${action} bypass policy ${pid} for affected policy ${aPid} as it doesn't exist`);
      continue;
    }
    if (policy.useBf) {
      const categories = policy.targets || [policy.target];
      categories.forEach(category => categoriesWithBfSet.add(category));
    }

    const tables = [];
    if (policy.action == "disturb") {
      tables.push('mangle');
      if (PolicyDisturbManager.checkIfNeedDisableQuic(policy)) {
        tables.push('filter');
      }
    } else {
      tables.push('filter');
    }

    const bypassChain = `FW_${aPid}_BYPASS`;
    const op = action === "unenforce" ? '-D' : '-I';

    if (action === "enforce") {
      for (const table of tables) {
        await ensureCreateBypassChain(table, aPid);
      }
    }


    const rulesToAdd = [];
    if (!_.isEmpty(tags) || !_.isEmpty(intfs) || !_.isEmpty(scope) || !_.isEmpty(guids)) {

      if (!_.isEmpty(tags)) {
        const Tag = require('../net2/Tag.js');
        const NetworkProfile = require('../net2/NetworkProfile.js');
        for (const uid of tags) {
          await Tag.ensureCreateEnforcementEnv(uid);
          const devSet = Tag.getTagDeviceSetName(uid);
          const netSet = Tag.getTagNetSetName(uid);
          for (const table of tables) {
            for (const family of [4, 6]) {
              // outbound rule to bypass traffic from devices in the tag
              rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${devSet} src`).jmp("RETURN"));
              rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${netSet} src,src`).jmp("RETURN"));
              // inbound rule to bypass traffic to devices in the tag
              rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${devSet} dst`).jmp("RETURN"));
              rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${netSet} dst,dst`).jmp("RETURN"));
            }
          }
        }
      }

      if (!_.isEmpty(intfs)) {
        const NetworkProfile = require('../net2/NetworkProfile.js');
        for (const uuid of intfs) {
          await NetworkProfile.ensureCreateEnforcementEnv(uuid);
          const intfSet = NetworkProfile.getNetListIpsetName(uuid);
          for (const table of tables) {
            rulesToAdd.push(new Rule(table).chn(bypassChain).mdl("set", `--match-set ${intfSet} src,src`).jmp("RETURN"));
            rulesToAdd.push(new Rule(table).fam(6).chn(bypassChain).mdl("set", `--match-set ${intfSet} src,src`).jmp("RETURN"));
            rulesToAdd.push(new Rule(table).chn(bypassChain).mdl("set", `--match-set ${intfSet} dst,dst`).jmp("RETURN"));
            rulesToAdd.push(new Rule(table).fam(6).chn(bypassChain).mdl("set", `--match-set ${intfSet} dst,dst`).jmp("RETURN"));
          }
        }
      }

      if (!_.isEmpty(scope)) {
        const Host = require('../net2/Host.js');
        for (const mac of scope) {
          await Host.ensureCreateEnforcementEnv(mac);
          const devSet = Host.getDeviceSetName(mac);
          for (const table of tables) {
            for (const family of [4, 6]) {
              rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${devSet} src`).jmp("RETURN"));
              rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${devSet} dst`).jmp("RETURN"));
            }
          }
        }
      }
  
      if (!_.isEmpty(guids)) {
        const IdentityManager = require('../net2/IdentityManager.js');
        for (const guid of guids) {
          const identityClass = IdentityManager.getIdentityClassByGUID(guid);
          if (!identityClass) continue;
          const { uid } = IdentityManager.getNSAndUID(guid);
          await identityClass.ensureCreateEnforcementEnv(uid);
          const set4 = identityClass.getEnforcementIPsetName(uid, 4);
          const set6 = identityClass.getEnforcementIPsetName(uid, 6);
          for (const table of tables) {
            rulesToAdd.push(new Rule(table).fam(4).chn(bypassChain).mdl("set", `--match-set ${set4} src`).jmp("RETURN"));
            rulesToAdd.push(new Rule(table).fam(4).chn(bypassChain).mdl("set", `--match-set ${set4} dst`).jmp("RETURN"));
            rulesToAdd.push(new Rule(table).fam(6).chn(bypassChain).mdl("set", `--match-set ${set6} src`).jmp("RETURN"));
            rulesToAdd.push(new Rule(table).fam(6).chn(bypassChain).mdl("set", `--match-set ${set6} dst`).jmp("RETURN"));
          }
        }
      }
    } else { // global bypass without specific match criteria, just jump to RETURN for all traffic in the bypass chain
      for (const table of tables) {
        for (const family of [4, 6]) {
          rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).jmp("RETURN").opr(op));
        }
      }
    }
      
    for (const rule of rulesToAdd) {
      await iptc.addRule(rule.opr(op));
    }
  }
}



module.exports = {
  ensureCreateBypassChain,
  isBypassChainExist,
  removeBypassChain,
  bypassDNSRules,
  bypassIptablesRules
}

