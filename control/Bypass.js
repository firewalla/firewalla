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


async function setupTagsRules(options) {
  const {affectedPids, tags, intfs, action, pid, targets, type} = options;
  const PolicyManager2 = require('../alarm/PolicyManager2.js');
  const CategoryUpdater = require('../control/CategoryUpdater.js')
  const categoryUpdater = new CategoryUpdater()
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

    if ((policy.type != "category" && policy.type != "mac" && policy.type != "internet") || (policy.action != "block" && policy.action != "app_block" && policy.action != "disturb")) {
      log.info(`skipping to ${action} bypass policy ${pid} for affected policy ${aPid} as it is not a blocking/disturb category policy`);
      continue;
    }


    const bypassChain = `FW_${aPid}_BYPASS`;
    const tables = [];
    const PolicyDisturbManager = require('../alarm/PolicyDisturbManager.js');
    if (policy.action == "disturb") {
      tables.push('mangle');
      if (PolicyDisturbManager.checkIfNeedDisableQuic(policy)) {
        tables.push('filter');
      }
    } else {
      tables.push('filter');
    }

    if (action === "enforce") {
      //ensure bypass chain exists
      for (const table of tables) {
        await ensureCreateBypassChain(table, aPid);
      }
    } else if (action === "unenforce") {
      // should do some check here?
    }

    const Tag = require('../net2/Tag.js');
    const NetworkProfile = require('../net2/NetworkProfile.js');
    const rulesToAdd = [];
    for (const table of tables) {
      for (const uid of tags) {
        await Tag.ensureCreateEnforcementEnv(uid);
        const devSet = Tag.getTagDeviceSetName(uid);
        const netSet = Tag.getTagNetSetName(uid);
          for (const family of [4, 6]) {
            // outbound rule to bypass traffic from devices in the tag
            rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${devSet} src`).jmp("RETURN"));
            rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${netSet} src,src`).jmp("RETURN"));
            // inbound rule to bypass traffic to devices in the tag
            rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${devSet} dst`).jmp("RETURN"));
            rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${netSet} dst,dst`).jmp("RETURN"));
          }
      }

      for (const intf of intfs) {
        await NetworkProfile.ensureCreateEnforcementEnv(intf);
        const intfSet = NetworkProfile.getNetListIpsetName(intf);
    
        // outbound rule to bypass traffic from devices in the interface
        rulesToAdd.push(new Rule(table).chn(bypassChain).mdl("set", `--match-set ${intfSet} src,src`).jmp("RETURN"));
        rulesToAdd.push(new Rule(table).fam(6).chn(bypassChain).mdl("set", `--match-set ${intfSet} src,src`).jmp("RETURN"));
        // inbound rule to bypass traffic to devices in the interface
        rulesToAdd.push(new Rule(table).chn(bypassChain).mdl("set", `--match-set ${intfSet} dst,dst`).jmp("RETURN"));
        rulesToAdd.push(new Rule(table).fam(6).chn(bypassChain).mdl("set", `--match-set ${intfSet} dst,dst`).jmp("RETURN"));
      }
    }

    let op = '-I'
    if (action === "unenforce") {
      op = '-D'
    }
    for (const rule of rulesToAdd) {
      await iptc.addRule(rule.opr(op)); // insert rule to the top of bypass chain
    }
  }

  if (type == "category") {
    // bypass dnsmasq rules
    if (action == "enforce") {
      await domainBlock.blockCategory({
        pid: pid,
        categories: targets,
        action: "bypass",
        tags: tags
      });

      if (categoriesWithBfSet.size > 0) {
        await domainBlock.blockCategory({
          pid: pid,
          categories: Array.from(categoriesWithBfSet).map(target => categoryUpdater.getBfCategoryName(target)),
          action: "bypass",
          tags: tags,
          append: true
        });
      }
    } else if (action == "unenforce") {
      await domainBlock.unblockCategory({
        pid: pid,
        categories: targets,
        action: "bypass",
        tags: tags
      });
    }
  }

}

module.exports = {
    setupTagsRules,
    ensureCreateBypassChain,
    isBypassChainExist,
    removeBypassChain
}