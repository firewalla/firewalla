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
'use strict'

const expect = require('chai').expect;

const AutoBlocksRevalidationSensor = require('../sensor/AutoBlocksRevalidationSensor.js');
const DestIPFoundHook = require('../hook/DestIPFoundHook');
const PolicyManager2 = require('../alarm/PolicyManager2');
const IntelTool = require('../net2/IntelTool');

describe('AutoBlocksRevalidationSensor', () => {
  // all singletons, so these are the instances the sensor uses
  const pm2 = new PolicyManager2();
  const intelTool = new IntelTool();
  const rule = { pid: 99999, method: 'auto', type: 'dns', target: 'malware.example.com' };
  const processIP = DestIPFoundHook.prototype.processIP;
  let sensor, lookups, deleted, unblocked;

  before(() => {
    sensor = new AutoBlocksRevalidationSensor({});
    pm2.loadActivePoliciesAsync = async () => [rule];
    pm2.disableAndDeletePolicy = async (pid) => { deleted.push(pid) };
    pm2.markAsShouldDelete = async (pid) => { deleted.push(pid) };
    intelTool.setUnblockExpire = async (target) => { unblocked.push(target) };
  });

  after(() => {
    DestIPFoundHook.prototype.processIP = processIP;
    for (const name of ['loadActivePoliciesAsync', 'disableAndDeletePolicy', 'markAsShouldDelete'])
      delete pm2[name];
    delete intelTool.setUnblockExpire;
  });

  beforeEach(() => {
    lookups = 0;
    deleted = [];
    unblocked = [];
  });

  for (const [desc, result] of [
    ['the intel lookup failed', { host: rule.target, cloudFailed: true }],
    ['processIP returned no result', null],
  ]) {
    it(`should keep the rule when ${desc}`, async () => {
      DestIPFoundHook.prototype.processIP = async () => { lookups++; return result };

      await sensor.iterateAllAutoBlocks();

      expect(lookups).to.equal(1);
      expect(deleted).to.be.empty;
      expect(unblocked).to.be.empty;
    });
  }
});
