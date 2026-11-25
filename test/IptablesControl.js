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

const { expect } = require('chai');
const iptc = require('../control/IptablesControl.js');
const { Rule } = require('../net2/Iptables.js');
const loggerManager = require('../net2/LoggerManager.js');

// the init batch merges the queued operations in order, so a re-enforce queued before the start
// enforcement of the same rule deletes a rule that is not there yet
describe('IptablesControl.mergeQueuedToAggregated', function () {
  this.timeout(5000);

  const log = loggerManager.loggers['IptablesControl'];
  const chain = 'FW_FIREWALL_DEV_G_BLOCK';
  const saved = {};
  let errors, agg;

  const rule = op => new Rule('filter').fam(4).chn(chain).set('c_tag_16_dev_set', 'src').comment('rule_1').jmp('FW_1_BYPASS').opr(op);
  const merge = rules => iptc.mergeQueuedToAggregated(4, 'filter', { 4: { filter: rules } });

  before(() => {
    saved.error = log.error;
    saved.aggregatedRules = iptc.aggregatedRules;
    log.error = (...args) => { errors.push(args.join(' ')); };
  });

  after(() => {
    log.error = saved.error;
    iptc.aggregatedRules = saved.aggregatedRules;
  });

  beforeEach(() => {
    errors = [];
    iptc.aggregatedRules = iptc._emptyState();
    agg = iptc.aggregatedRules[4].filter;
    agg.chains[chain] = `:${chain} - [0:0]`;
  });

  it('a delete of a rule whose chain is not declared yet is a no-op and not an error', () => {
    expect(merge([rule('-D')])).to.equal(false);
    expect(agg.rules).to.deep.equal([]);
    expect(errors).to.deep.equal([]);
  });

  it('an add into a chain that is not declared is still an error', () => {
    expect(merge([rule('-A')])).to.equal(false);
    expect(agg.rules).to.deep.equal([]);
    expect(errors).to.have.length(1);
  });

  it('a delete queued before the add leaves the rule in place, one queued after removes it', () => {
    merge([rule('-D'), new Rule('filter').fam(4).chn('FW_1_BYPASS').opr('-N'), rule('-A'), rule('-A')]);
    expect(agg.rules).to.deep.equal([rule('-A').essential()]);
    expect(merge([rule('-D')])).to.equal(true);
    expect(agg.rules).to.deep.equal([null]);
    expect(errors).to.deep.equal([]);
  });
});
