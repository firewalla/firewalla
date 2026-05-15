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

// Iptables layout for multi-target disturb policies:
//
// 1. The regular Block.js setup path does a coarse jump into the policy BYPASS
//    chain from the scope-specific disturb chain. It does not set CONNMARK for
//    multi-target disturb rules.
//
// 2. FW_${pid}_BYPASS keeps the usual bypass semantics: action=bypass rules can
//    insert RETURN rules at the top, so exempted devices leave before any app
//    disturb mark is applied. Per-app match rules are appended after those
//    RETURN rules, and each match jumps to its own MARK chain.
//
// 3. FW_${pid}_${subkey}_MARK is the only place that writes the app's QoS
//    CONNMARK. Keeping one MARK chain per app prevents later app matches from
//    overwriting earlier app marks in the shared BYPASS chain.

const crypto = require('crypto');
const _ = require('lodash');
const { Rule } = require('../net2/Iptables.js');
const iptc = require('./IptablesControl.js');

const FAMILIES = [4, 6];

function _getTargets(policy) {
  return _.uniq(_.compact(_.concat(policy.targets, policy.target)));
}

function subKeyFor(target) {
  return crypto.createHash('md5').update(String(target)).digest('hex').slice(0, 8);
}

function _markChainName(pid, target) {
  return `FW_${pid}_${subKeyFor(target)}_MARK`;
}

function _isMultiTarget(policy) {
  return _getTargets(policy).length > 1;
}

// eg: iptables -t mangle -N FW_${PID}_${SUBKEY}_MARK
function _markChainCreateRules(pid, targets) {
  const rules = [];
  for (const target of targets) {
    const chain = _markChainName(pid, target);
    for (const family of FAMILIES) {
      rules.push(new Rule('mangle').fam(family).chn(chain).opr('-N'));
    }
  }
  return rules;
}

// eg:
//   iptables -t mangle -F FW_${PID}_${SUBKEY}_MARK
//   iptables -t mangle -X FW_${PID}_${SUBKEY}_MARK
function _markChainDestroyRules(pid, targets) {
  const rules = [];
  for (const target of targets) {
    const chain = _markChainName(pid, target);
    for (const family of FAMILIES) {
      rules.push(new Rule('mangle').fam(family).chn(chain).opr('-F'));
      rules.push(new Rule('mangle').fam(family).chn(chain).opr('-X'));
    }
  }
  return rules;
}

// Set up dispatch chains before Block.js installs the per-app match rules.
async function setupDispatchForPolicy(policy) {
  if (!_isMultiTarget(policy)) return;
  const pid = String(policy.pid);
  const targets = _getTargets(policy);
  for (const r of _markChainCreateRules(pid, targets)) await iptc.addRule(r);
}

// Tear down dispatch chains after Block.js removes the per-app match rules.
async function teardownDispatchForPolicy(policy) {
  if (!_isMultiTarget(policy)) return;
  const pid = String(policy.pid);
  const targets = _getTargets(policy);
  for (const r of _markChainDestroyRules(pid, targets)) await iptc.addRule(r);
}

module.exports = {
  subKeyFor,
  setupDispatchForPolicy,
  teardownDispatchForPolicy,
};
