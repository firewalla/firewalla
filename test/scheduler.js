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
const scheduler = require('../extension/scheduler/scheduler.js');

describe('scheduler.registerPolicy', function () {
  this.timeout(5000);

  const policy = { pid: 'scheduler-test', cronTime: '0 9 * * *', duration: 3600 };
  const saved = {};
  let windowChecks, applied;

  before(() => {
    saved.shouldPolicyBeRunning = scheduler.shouldPolicyBeRunning;
    saved.apply = scheduler.apply;
    // the second register would apply the rule if it went on past the running-job check
    scheduler.shouldPolicyBeRunning = () => ++windowChecks > 1 ? 1800 : 0;
    scheduler.apply = async () => { applied++; };
  });

  after(async () => {
    await scheduler.deregisterPolicy(policy);
    scheduler.shouldPolicyBeRunning = saved.shouldPolicyBeRunning;
    scheduler.apply = saved.apply;
  });

  beforeEach(() => {
    windowChecks = 0;
    applied = 0;
  });

  it('a second register of a rule whose job is running keeps that job and does not throw', async () => {
    await scheduler.registerPolicy(policy);
    // the start enforcement of a rule that a re-enforce has already registered
    await scheduler.registerPolicy(policy);
    expect(windowChecks).to.equal(1);
    expect(applied).to.equal(0);
  });
});
