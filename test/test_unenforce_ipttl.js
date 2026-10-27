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

'use strict';

// a global domain rule with ipttl is enforced on its own c_bd_<pid>_set,
// _unenforce must tear down that set instead of the shared block_domain_set

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const proxyquire = require('proxyquire').noCallThru();

const Constants = require('../net2/Constants.js');

// a value that can be called, constructed and dereferenced to any depth,
// stands in for the singletons and clients PolicyManager2 builds at load time
function anything() {
  const proxy = new Proxy(function () {}, {
    get: (target, prop) => (prop === 'then' || typeof prop === 'symbol') ? undefined : proxy,
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

// like anything(), with the given members
function partial(members) {
  const rest = anything();
  return new Proxy(members, { get: (target, prop) => prop in target ? target[prop] : rest[prop] });
}

function loadPolicyManager2(overrides) {
  const src = fs.readFileSync(path.join(__dirname, '../alarm/PolicyManager2.js'), 'utf8');
  const stubs = {};
  for (const [, name] of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    stubs[name] = anything();
  }
  stubs['../net2/Constants.js'] = Constants;
  stubs['lodash'] = require('lodash');
  return proxyquire('../alarm/PolicyManager2.js', Object.assign(stubs, overrides));
}

describe('PolicyManager2._unenforce with ipttl', function () {
  let pm2, unblocked;

  before(() => {
    unblocked = [];
    const PolicyManager2 = loadPolicyManager2({
      '../control/DomainBlock.js': { unblockDomain: async (target, opts) => { unblocked.push(opts.blockSet); } },
      '../control/Block.js': partial({
        getDstSet: (pid) => `c_bd_${pid}_set`,
        getDstSet6: (pid) => `c_bd_${pid}_set6`,
        getConnSet: (pid) => `c_bd_${pid}_conn`,
        getConnSet6: (pid) => `c_bd_${pid}_conn6`,
      }),
      '../platform/PlatformLoader.js': {
        getPlatform: () => partial({ isTLSBlockSupport: () => false, isUdpTLSBlockSupport: () => false }),
      },
      '../util/util.js': { delay: async () => {}, isDomainTargetValid: () => true },
    });
    pm2 = Object.create(PolicyManager2.prototype);
    pm2._removeActivatedTime = async () => {};
    pm2.resolveRuleScope = async () => ({ intfs: [], tags: [] });
    pm2._getRuleSubPriority = () => 0;
  });

  function policy(fields) {
    return Object.assign({
      pid: '42', type: 'dns', target: 'example.com', action: 'block',
      needPolicyDisturb: () => false,
      isSecurityBlockPolicy: () => false,
      isSchedulingPolicy: () => false,
      getSeq: () => Constants.RULE_SEQ_REG,
    }, fields);
  }

  beforeEach(() => { unblocked.length = 0; });

  it('unblocks the per-rule set of a global domain rule with ipttl', async () => {
    await pm2._unenforce(policy({ ipttl: 300 }));
    expect(unblocked).to.eql(['c_bd_42_set']);
  });

  it('still unblocks the shared set of a global domain rule without ipttl', async () => {
    await pm2._unenforce(policy({}));
    expect(unblocked).to.eql(['block_domain_set']);
  });
});
