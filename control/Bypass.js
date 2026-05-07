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
const Constants = require('../net2/Constants.js');
const { action } = require('commander');


async function bypassDNSRules(options) {

  const {affectedPids, tags, intfs, action, pid, targets, type} = options;
  const PolicyManager2 = require('../alarm/PolicyManager2.js');
  const CategoryUpdater = require('../control/CategoryUpdater.js')
  const categoryUpdater = new CategoryUpdater()
  const pm2 = new PolicyManager2();
  const categoriesWithBfSet = new Set();
  let hasHiSeq = false;
  let hasNonHiSeq = false;
  let optionsArray = [];

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

    if (policy.seq === Constants.RULE_SEQ_HI) {
      hasHiSeq = true;
    } else {
      hasNonHiSeq = true;
    }

    let shouldAppend = false;
    
    // bypass dnsmasq rules
    if (action == "enforce") {
      if (hasHiSeq) {
        optionsArray.push({
          pid: pid,
          categories: targets,
          action: "bypass",
          tags: tags,
          seq: Constants.RULE_SEQ_HI,
          append: shouldAppend,
        });
        shouldAppend = true;
        if (categoriesWithBfSet.size > 0) {
          optionsArray.push({
            pid: pid,
            categories: Array.from(categoriesWithBfSet).map(target => categoryUpdater.getBfCategoryName(target)),
            action: "bypass",
            tags: tags,
            seq: Constants.RULE_SEQ_HI,
            append: shouldAppend,
          });
          shouldAppend = true;
        }
      }
      if (hasNonHiSeq) {
        optionsArray.push({
          pid: pid,
          categories: targets,
          action: "bypass",
          tags: tags,
          append: shouldAppend,
        });
        shouldAppend = true;
        if (categoriesWithBfSet.size > 0) {
          optionsArray.push({
            pid: pid,
            categories: Array.from(categoriesWithBfSet).map(target => categoryUpdater.getBfCategoryName(target)),
            action: "bypass",
            tags: tags,
            append: shouldAppend,
          });
          shouldAppend = true;
        }
      }
    } else if (action == "unenforce") {
      optionsArray.push({
        pid: pid,
        categories: targets,
        action: "bypass",
        tags: tags
      });
    }
  }

  const asyncOps = [];
  for (const opts of optionsArray) {
    if (action == "enforce") {
      asyncOps.push(addPolicyCategoryFilterEntry(opts).catch(err => {
        log.error(`Failed to add policy category filter entry for ${opts.pid}: ${err}`);
      }));
    } else if (action == "unenforce") {
      asyncOps.push(removePolicyCategoryFilterEntry(opts).catch(err => {
        log.error(`Failed to remove policy category filter entry for ${opts.pid}: ${err}`);
      }));
    }
  }
  if (optionsArray.length > 0) {
    await Promise.all(asyncOps);
    await dnsmasq.scheduleRestartDNSService();
  }
}

async function bypassIptablesRules(options) {
  const {affectedPids, tags, intfs, action, pid, targets, scope, guids, type} = options;
  const PolicyManager2 = require('../alarm/PolicyManager2.js');
  const pm2 = new PolicyManager2();
  const categoriesWithBfSet = new Set();

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


    const bypassChain = `FW_${aPid}_BYPASS`;
    const table = policy.action == "disturb" ? "mangle" : "filter";
    const op = action === "unenforce" ? '-D' : '-I';

    if (action === "enforce") {
      for (const family of ['4', '6']) {
        const rule = new Rule(table).fam(family).chn(bypassChain).opr('-N');
        iptc.addRule(rule);
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
          for (const family of ['4', '6']) {
            // outbound rule to bypass traffic from devices in the tag
            rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${devSet} src`).jmp("RETURN"));
            rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${netSet} src,src`).jmp("RETURN"));
            // inbound rule to bypass traffic to devices in the tag
            rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${devSet} dst`).jmp("RETURN"));
            rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${netSet} dst,dst`).jmp("RETURN"));
          }
        }
      }

      if (!_.isEmpty(intfs)) {
        const NetworkProfile = require('../net2/NetworkProfile.js');
        for (const uuid of uuids) {
          await NetworkProfile.ensureCreateEnforcementEnv(uuid);
          const intfSet = NetworkProfile.getNetListIpsetName(uuid);
          rulesToAdd.push(new Rule(table).chn(bypassChain).mdl("set", `--match-set ${intfSet} src,src`).jmp("RETURN"));
          rulesToAdd.push(new Rule(table).fam(6).chn(bypassChain).mdl("set", `--match-set ${intfSet} src,src`).jmp("RETURN"));
          rulesToAdd.push(new Rule(table).chn(bypassChain).mdl("set", `--match-set ${intfSet} dst,dst`).jmp("RETURN"));
          rulesToAdd.push(new Rule(table).fam(6).chn(bypassChain).mdl("set", `--match-set ${intfSet} dst,dst`).jmp("RETURN"));
        }
      }

      if (!_.isEmpty(scope)) {
        const Host = require('../net2/Host.js');
        
        for (const mac of macAddresses) {
          await Host.ensureCreateEnforcementEnv(mac);
          const devSet = Host.getDeviceSetName(mac);
          for (const family of ['4', '6']) {
            rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${devSet} src`).jmp("RETURN"));
            rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${devSet} dst`).jmp("RETURN"));
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
          rulesToAdd.push(new Rule(table).fam(4).chn(bypassChain).mdl("set", `--match-set ${set4} src`).jmp("RETURN"));
          rulesToAdd.push(new Rule(table).fam(4).chn(bypassChain).mdl("set", `--match-set ${set4} dst`).jmp("RETURN"));
          rulesToAdd.push(new Rule(table).fam(6).chn(bypassChain).mdl("set", `--match-set ${set6} src`).jmp("RETURN"));
          rulesToAdd.push(new Rule(table).fam(6).chn(bypassChain).mdl("set", `--match-set ${set6} dst`).jmp("RETURN"));
        }
      }
    } else { // global bypass without specific match criteria, just jump to RETURN for all traffic in the bypass chain
      for (const family of ['4', '6']) {
        rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).jmp("RETURN").opr(op));
      }
    }
      
    for (const rule of rulesToAdd) {
      iptc.addRule(rule.opr(op));
    }
  }
}



module.exports = {
  setupTagsRules,
  ensureCreateBypassChain,
  isBypassChainExist,
  removeBypassChain,
  setupIntfsRules,
  setupDevicesRules,
  setupGenericIdentitiesRules,
  setupGlobalRules,
  bypassDNSRules,
  bypassIptablesRules
}