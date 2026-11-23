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

'use strict'

const chai = require('chai');
const expect = chai.expect;

const sysManager = require('../net2/SysManager.js');
const BlockStatsSensor = require('../sensor/BlockStatsSensor.js');

const MAC = 'AA:BB:CC:DD:EE:01';
const NRD = { and: [{ field: 'bType', value: 'category' }, { field: 'bTarget', value: 'nrd' }] };
const COUNTRY = { field: 'bType', value: 'country' };
const SETTINGS = [
  { key: 'block::nrd', filter: NRD, identityKey: ['device'], destKeys: ['device', 'dest'] },
  { key: 'block::country', filter: COUNTRY, identityKey: ['device'], destKeys: ['device', 'dest', 'bTarget', 'fd'] }
];

function blockEvent(overrides) {
  return Object.assign({ device: MAC, dest: 'new.example.org', bType: 'category', bTarget: 'nrd', fd: 'in', ct: 1, _ts: 1760000000 }, overrides);
}

describe('test block stats sensor', function () {
  this.timeout(10000);

  const realLocalOrSearchDomain = sysManager.isLocalOrSearchDomain;
  let searchDomains;

  beforeEach(() => {
    searchDomains = [];
    sysManager.isLocalOrSearchDomain = d => searchDomains.some(sd => d.endsWith(`.${sd}`));
  });

  afterEach(() => {
    sysManager.isLocalOrSearchDomain = realLocalOrSearchDomain;
  });

  const newSensor = (extra = {}) => {
    const sensor = new BlockStatsSensor({ blockStatsSettings: SETTINGS, slotSecs: 86400, ...extra });
    sensor.applyConfig(null);
    return sensor;
  };

  // the total of the counted events, over every bucket and setting
  const counted = sensor => Object.values(sensor.buckets)
    .flatMap(b => Object.values(b))
    .flatMap(rec => Array.from(rec.identities.values()))
    .reduce((sum, id) => sum + id.cnt, 0);

  describe('local and search domains', () => {
    it('counts the bare name', () => {
      const sensor = newSensor();
      searchDomains = ['lan'];
      sensor._onBlockFlow(blockEvent({ dest: 'foo.xn--x.de' }));
      expect(counted(sensor)).to.equal(1);
      expect(sensor.dirty.size).to.equal(1);
    });

    it('does not count a name under the local domain suffix', () => {
      const sensor = newSensor();
      searchDomains = ['lan'];
      sensor._onBlockFlow(blockEvent({ dest: 'foo.xn--x.de.lan' }));
      expect(counted(sensor)).to.equal(0);
    });

    it('does not count a name under a search domain of an interface', () => {
      const sensor = newSensor();
      searchDomains = ['corp.test'];
      sensor._onBlockFlow(blockEvent({ dest: 'foo.xn--x.de.corp.test' }));
      expect(counted(sensor)).to.equal(0);
    });

    it('counts a name outside every search domain', () => {
      const sensor = newSensor();
      searchDomains = ['lan', 'corp.test'];
      sensor._onBlockFlow(blockEvent({ dest: 'foo.xn--x.de.example.org' }));
      expect(counted(sensor)).to.equal(1);
    });

    it('counts an IP dest', () => {
      const sensor = newSensor();
      searchDomains = ['lan'];
      sensor._onBlockFlow(blockEvent({ bType: 'country', bTarget: 'XX', dest: '203.0.113.9' }));
      expect(counted(sensor)).to.equal(1);
    });

    it('skips a suffixed name for a country setting as well', () => {
      const sensor = newSensor();
      searchDomains = ['lan'];
      sensor._onBlockFlow(blockEvent({ bType: 'country', bTarget: 'XX', dest: 'foo.example.de.lan' }));
      expect(counted(sensor)).to.equal(0);
    });

    it('lets an ignoredDests entry win for the bare name', () => {
      const sensor = newSensor({ ignoredDests: ['*.example.org'] });
      sensor._onBlockFlow(blockEvent({ dest: 'foo.example.org' }));
      expect(counted(sensor)).to.equal(0);
      expect(sensor.dirty.size).to.equal(0);
    });

    it('leaves the buckets and dirty set untouched for a skipped event', () => {
      const sensor = newSensor();
      searchDomains = ['lan'];
      sensor._onBlockFlow(blockEvent({ dest: 'foo.xn--x.de.lan' }));
      expect(sensor.buckets).to.deep.equal({});
      expect(sensor.dirty.size).to.equal(0);
    });

    it('checks the suffixes once per event, and only for an event a setting selected', () => {
      const sensor = newSensor();
      let checked = 0;
      sysManager.isLocalOrSearchDomain = () => { checked++; return false; };
      sensor._onBlockFlow(blockEvent({ bTarget: 'porn' }));
      expect(checked).to.equal(0);
      sensor._onBlockFlow(blockEvent());
      expect(checked).to.equal(1);
      // two settings select this one, and the check still runs once
      const both = newSensor({ blockStatsSettings: [SETTINGS[0], { ...SETTINGS[0], key: 'block::nrd2' }] });
      checked = 0;
      both._onBlockFlow(blockEvent());
      expect(checked).to.equal(1);
    });

    it('does not check an ignored dest', () => {
      const sensor = newSensor({ ignoredDests: ['*.example.org'] });
      let checked = 0;
      sysManager.isLocalOrSearchDomain = () => { checked++; return false; };
      sensor._onBlockFlow(blockEvent({ dest: 'foo.example.org' }));
      expect(checked).to.equal(0);
    });

    it('uses the real suffix checks of SysManager', () => {
      const origSuffix = sysManager.localDomainSuffix;
      const origIntfs = sysManager.getMonitoringInterfaces;
      sysManager.isLocalOrSearchDomain = realLocalOrSearchDomain;
      sysManager.localDomainSuffix = 'lan';
      sysManager.getMonitoringInterfaces = () => [{ name: 'br0' }, { name: 'br1', searchDomains: ['corp.test'] }];
      try {
        const sensor = newSensor();
        sensor._onBlockFlow(blockEvent({ dest: 'foo.xn--x.de.lan' }));
        sensor._onBlockFlow(blockEvent({ dest: 'foo.xn--x.de.corp.test' }));
        expect(counted(sensor)).to.equal(0);
        sensor._onBlockFlow(blockEvent({ dest: 'foo.xn--x.de' }));
        expect(counted(sensor)).to.equal(1);
      } finally {
        sysManager.localDomainSuffix = origSuffix;
        sysManager.getMonitoringInterfaces = origIntfs;
      }
    });
  });
});
