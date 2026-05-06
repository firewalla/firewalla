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
const Constants = require('../net2/Constants.js');


async function setupTagsRules(options) {
  const {affectedPids, tags, intfs, action, pid, targets, type} = options;
  const PolicyManager2 = require('../alarm/PolicyManager2.js');
  const CategoryUpdater = require('../control/CategoryUpdater.js')
  const categoryUpdater = new CategoryUpdater()
  const pm2 = new PolicyManager2();
  const categoriesWithBfSet = new Set();
  let hasHiSeq = false;
  let hasNonHiSeq = false;


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

    if (policy.seq === Constants.RULE_SEQ_HI) {
      hasHiSeq = true;
    } else {
      hasNonHiSeq = true;
    }

    if ((policy.type != "category" && policy.type != "mac" && policy.type != "internet") || (policy.action != "block" && policy.action != "app_block" && policy.action != "disturb")) {
      log.info(`skipping to ${action} bypass policy ${pid} for affected policy ${aPid} as it is not a blocking/disturb category policy`);
      continue;
    }


    const bypassChain = `FW_${aPid}_BYPASS`;
    const table = policy.action == "disturb" ? "mangle" : "filter";

    if (action === "enforce") {
      //ensure bypass chain exists
      for (const family of ['4', '6']) {
        const rule = new Rule(table).fam(family).chn(bypassChain).opr('-N');
        iptc.addRule(rule);
      }
    } else if (action === "unenforce") {
      // should do some check here?
    }

    const Tag = require('../net2/Tag.js');
    const NetworkProfile = require('../net2/NetworkProfile.js');
    const rulesToAdd = [];
    
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

    let op = '-I'
    if (action === "unenforce") {
      op = '-D'
    }
    for (const rule of rulesToAdd) {
      iptc.addRule(rule.opr(op)); // insert rule to the top of bypass chain
    }
  }

  if (type == "category") {
    // bypass dnsmasq rules
    if (action == "enforce") {
      if (hasHiSeq) {
        await domainBlock.blockCategory({
          pid: pid,
          categories: targets,
          action: "bypass",
          tags: tags,
          seq: Constants.RULE_SEQ_HI,
          append: true
        });
        if (categoriesWithBfSet.size > 0) {
          await domainBlock.blockCategory({
            pid: pid,
            categories: Array.from(categoriesWithBfSet).map(target => categoryUpdater.getBfCategoryName(target)),
            action: "bypass",
            tags: tags,
            seq: Constants.RULE_SEQ_HI,
            append: true
          });
        }
      }
      if (hasNonHiSeq) {
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

async function setupIntfsRules(options) {
  const {affectedPids, uuids, action, pid, targets, type} = options;
  if (_.isEmpty(uuids)) return;
  const PolicyManager2 = require('../alarm/PolicyManager2.js');
  const CategoryUpdater = require('../control/CategoryUpdater.js');
  const categoryUpdater = new CategoryUpdater();
  const pm2 = new PolicyManager2();
  const categoriesWithBfSet = new Set();
  let hasHiSeq = false;
  let hasNonHiSeq = false;

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

    if ((policy.type != "category" && policy.type != "mac" && policy.type != "internet") || (policy.action != "block" && policy.action != "app_block" && policy.action != "disturb")) {
      log.info(`skipping to ${action} bypass policy ${pid} for affected policy ${aPid} as it is not a blocking/disturb category policy`);
      continue;
    }

    const bypassChain = `FW_${aPid}_BYPASS`;
    const table = policy.action == "disturb" ? "mangle" : "filter";

    if (action === "enforce") {
      for (const family of ['4', '6']) {
        const rule = new Rule(table).fam(family).chn(bypassChain).opr('-N');
        iptc.addRule(rule);
      }
    }

    const NetworkProfile = require('../net2/NetworkProfile.js');
    const rulesToAdd = [];
    for (const uuid of uuids) {
      await NetworkProfile.ensureCreateEnforcementEnv(uuid);
      const intfSet = NetworkProfile.getNetListIpsetName(uuid);
      rulesToAdd.push(new Rule(table).chn(bypassChain).mdl("set", `--match-set ${intfSet} src,src`).jmp("RETURN"));
      rulesToAdd.push(new Rule(table).fam(6).chn(bypassChain).mdl("set", `--match-set ${intfSet} src,src`).jmp("RETURN"));
      rulesToAdd.push(new Rule(table).chn(bypassChain).mdl("set", `--match-set ${intfSet} dst,dst`).jmp("RETURN"));
      rulesToAdd.push(new Rule(table).fam(6).chn(bypassChain).mdl("set", `--match-set ${intfSet} dst,dst`).jmp("RETURN"));
    }

    const op = action === "unenforce" ? '-D' : '-I';
    for (const rule of rulesToAdd) {
      iptc.addRule(rule.opr(op));
    }
  }

  let shouldAppend = false;

  if (type == "category") {
    if (action == "enforce") {
      if (hasHiSeq) {
        await domainBlock.blockCategory({
          pid: pid,
          categories: targets,
          action: "bypass",
          intfs: uuids,
          seq: Constants.RULE_SEQ_HI,
          append: shouldAppend,
        });
        shouldAppend = true;
        if (categoriesWithBfSet.size > 0) {
          await domainBlock.blockCategory({
            pid: pid,
            categories: Array.from(categoriesWithBfSet).map(target => categoryUpdater.getBfCategoryName(target)),
            action: "bypass",
            intfs: uuids,
            seq: Constants.RULE_SEQ_HI,
            append: shouldAppend,
          });
          shouldAppend = true;
        }
      }
      if (hasNonHiSeq) {
        await domainBlock.blockCategory({
          pid: pid,
          categories: targets,
          action: "bypass",
          intfs: uuids,
          append: shouldAppend,
        });
        shouldAppend = true;
        if (categoriesWithBfSet.size > 0) {
          await domainBlock.blockCategory({
            pid: pid,
            categories: Array.from(categoriesWithBfSet).map(target => categoryUpdater.getBfCategoryName(target)),
            action: "bypass",
            intfs: uuids,
            append: shouldAppend,
          });
          shouldAppend = true;
        }
      }
    } else if (action == "unenforce") {
      await domainBlock.unblockCategory({
        pid: pid,
        categories: targets,
        action: "bypass",
        intfs: uuids
      });
    }
  }
}

async function setupDevicesRules(options) {
  const {affectedPids, macAddresses, action, pid, targets, type} = options;
  if (_.isEmpty(macAddresses)) return;
  const PolicyManager2 = require('../alarm/PolicyManager2.js');
  const CategoryUpdater = require('../control/CategoryUpdater.js');
  const categoryUpdater = new CategoryUpdater();
  const pm2 = new PolicyManager2();
  const categoriesWithBfSet = new Set();
  let hasHiSeq = false;
  let hasNonHiSeq = false;

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

    if ((policy.type != "category" && policy.type != "mac" && policy.type != "internet") || (policy.action != "block" && policy.action != "app_block" && policy.action != "disturb")) {
      log.info(`skipping to ${action} bypass policy ${pid} for affected policy ${aPid} as it is not a blocking/disturb category policy`);
      continue;
    }

    const bypassChain = `FW_${aPid}_BYPASS`;
    const table = policy.action == "disturb" ? "mangle" : "filter";

    if (action === "enforce") {
      for (const family of ['4', '6']) {
        const rule = new Rule(table).fam(family).chn(bypassChain).opr('-N');
        iptc.addRule(rule);
      }
    }

    const Host = require('../net2/Host.js');
    const rulesToAdd = [];
    for (const mac of macAddresses) {
      await Host.ensureCreateEnforcementEnv(mac);
      const devSet = Host.getDeviceSetName(mac);
      for (const family of ['4', '6']) {
        rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${devSet} src`).jmp("RETURN"));
        rulesToAdd.push(new Rule(table).fam(family).chn(bypassChain).mdl("set", `--match-set ${devSet} dst`).jmp("RETURN"));
      }
    }

    const op = action === "unenforce" ? '-D' : '-I';
    for (const rule of rulesToAdd) {
      iptc.addRule(rule.opr(op));
    }
  }

  if (type == "category") {
    if (action == "enforce") {
      if (hasHiSeq) {
        await domainBlock.blockCategory({
          pid: pid,
          categories: targets,
          action: "bypass",
          scope: macAddresses,
          seq: Constants.RULE_SEQ_HI,
          append: true
        });
        if (categoriesWithBfSet.size > 0) {
          await domainBlock.blockCategory({
            pid: pid,
            categories: Array.from(categoriesWithBfSet).map(target => categoryUpdater.getBfCategoryName(target)),
            action: "bypass",
            scope: macAddresses,
            seq: Constants.RULE_SEQ_HI,
            append: true
          });
        }
      }
      if (hasNonHiSeq) {
        await domainBlock.blockCategory({
          pid: pid,
          categories: targets,
          action: "bypass",
          scope: macAddresses
        });
        if (categoriesWithBfSet.size > 0) {
          await domainBlock.blockCategory({
            pid: pid,
            categories: Array.from(categoriesWithBfSet).map(target => categoryUpdater.getBfCategoryName(target)),
            action: "bypass",
            scope: macAddresses,
            append: true
          });
        }
      }
    } else if (action == "unenforce") {
      await domainBlock.unblockCategory({
        pid: pid,
        categories: targets,
        action: "bypass",
        scope: macAddresses
      });
    }
  }
}

async function setupGenericIdentitiesRules(options) {
  const {affectedPids, guids, action, pid, targets, type} = options;
  if (_.isEmpty(guids)) return;
  const PolicyManager2 = require('../alarm/PolicyManager2.js');
  const CategoryUpdater = require('../control/CategoryUpdater.js');
  const categoryUpdater = new CategoryUpdater();
  const pm2 = new PolicyManager2();
  const categoriesWithBfSet = new Set();
  let hasHiSeq = false;
  let hasNonHiSeq = false;

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

    if ((policy.type != "category" && policy.type != "mac" && policy.type != "internet") || (policy.action != "block" && policy.action != "app_block" && policy.action != "disturb")) {
      log.info(`skipping to ${action} bypass policy ${pid} for affected policy ${aPid} as it is not a blocking/disturb category policy`);
      continue;
    }

    const bypassChain = `FW_${aPid}_BYPASS`;
    const table = policy.action == "disturb" ? "mangle" : "filter";

    if (action === "enforce") {
      for (const family of ['4', '6']) {
        const rule = new Rule(table).fam(family).chn(bypassChain).opr('-N');
        iptc.addRule(rule);
      }
    }

    const IdentityManager = require('../net2/IdentityManager.js');
    const rulesToAdd = [];
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

    const op = action === "unenforce" ? '-D' : '-I';
    for (const rule of rulesToAdd) {
      iptc.addRule(rule.opr(op));
    }
  }

  if (type == "category") {
    if (action == "enforce") {
      if (hasHiSeq) {
        await domainBlock.blockCategory({
          pid: pid,
          categories: targets,
          action: "bypass",
          guids: guids,
          seq: Constants.RULE_SEQ_HI,
          append: true
        });
        if (categoriesWithBfSet.size > 0) {
          await domainBlock.blockCategory({
            pid: pid,
            categories: Array.from(categoriesWithBfSet).map(target => categoryUpdater.getBfCategoryName(target)),
            action: "bypass",
            guids: guids,
            seq: Constants.RULE_SEQ_HI,
            append: true
          });
        }
      }
      if (hasNonHiSeq) {
        await domainBlock.blockCategory({
          pid: pid,
          categories: targets,
          action: "bypass",
          guids: guids
        });
        if (categoriesWithBfSet.size > 0) {
          await domainBlock.blockCategory({
            pid: pid,
            categories: Array.from(categoriesWithBfSet).map(target => categoryUpdater.getBfCategoryName(target)),
            action: "bypass",
            guids: guids,
            append: true
          });
        }
      }
    } else if (action == "unenforce") {
      await domainBlock.unblockCategory({
        pid: pid,
        categories: targets,
        action: "bypass",
        guids: guids
      });
    }
  }
}

async function setupGlobalRules(options) {
  const {affectedPids, action, pid, targets, type} = options;
  const PolicyManager2 = require('../alarm/PolicyManager2.js');
  const CategoryUpdater = require('../control/CategoryUpdater.js');
  const categoryUpdater = new CategoryUpdater();
  const pm2 = new PolicyManager2();
  const categoriesWithBfSet = new Set();
  let hasHiSeq = false;
  let hasNonHiSeq = false;

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

    if ((policy.type != "category" && policy.type != "mac" && policy.type != "internet") || (policy.action != "block" && policy.action != "app_block" && policy.action != "disturb")) {
      log.info(`skipping to ${action} bypass policy ${pid} for affected policy ${aPid} as it is not a blocking/disturb category policy`);
      continue;
    }

    const bypassChain = `FW_${aPid}_BYPASS`;
    const table = policy.action == "disturb" ? "mangle" : "filter";

    if (action === "enforce") {
      for (const family of ['4', '6']) {
        const rule = new Rule(table).fam(family).chn(bypassChain).opr('-N');
        iptc.addRule(rule);
      }
    }

    const op = action === "unenforce" ? '-D' : '-I';
    for (const family of ['4', '6']) {
      iptc.addRule(new Rule(table).fam(family).chn(bypassChain).jmp("RETURN").opr(op));
    }
  }

  if (type == "category") {
    if (action == "enforce") {
      if (hasHiSeq) {
        await domainBlock.blockCategory({
          pid: pid,
          categories: targets,
          action: "bypass",
          seq: Constants.RULE_SEQ_HI,
          append: true
        });
        if (categoriesWithBfSet.size > 0) {
          await domainBlock.blockCategory({
            pid: pid,
            categories: Array.from(categoriesWithBfSet).map(target => categoryUpdater.getBfCategoryName(target)),
            action: "bypass",
            seq: Constants.RULE_SEQ_HI,
            append: true
          });
        }
      }
      if (hasNonHiSeq) {
        await domainBlock.blockCategory({
          pid: pid,
          categories: targets,
          action: "bypass"
        });
        if (categoriesWithBfSet.size > 0) {
          await domainBlock.blockCategory({
            pid: pid,
            categories: Array.from(categoriesWithBfSet).map(target => categoryUpdater.getBfCategoryName(target)),
            action: "bypass",
            append: true
          });
        }
      }
    } else if (action == "unenforce") {
      await domainBlock.unblockCategory({
        pid: pid,
        categories: targets,
        action: "bypass"
      });
    }
  }
}

module.exports = {
    setupTagsRules,
    setupIntfsRules,
    setupDevicesRules,
    setupGenericIdentitiesRules,
    setupGlobalRules,
}