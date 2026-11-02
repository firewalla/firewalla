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

// audit:dns:<mac> / audit:dns:system (allowed DNS records, dnsmasq_log_allow_redis)
// must be trimmed by OldDataCleanSensor and compacted by ACLAuditLogPlugin.mergeLogs

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const proxyquire = require('proxyquire').noCallThru();

// a value that can be called, constructed and dereferenced to any depth,
// stands in for the singletons and clients the sensors build at load time
function anything() {
  const proxy = new Proxy(function () {}, {
    get: (target, prop) => (prop === 'then' || typeof prop === 'symbol') ? undefined : proxy,
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

// stub every module the sensor requires, plain constant modules stay real
function loadSensor(file, overrides) {
  const src = fs.readFileSync(path.join(__dirname, '../sensor', file), 'utf8');
  const stubs = {};
  for (const [, name] of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    stubs[name] = anything();
  }
  stubs['./Sensor.js'] = { Sensor: class { constructor(config) { this.config = config || {}; } } };
  stubs['../net2/Constants.js'] = require('../net2/Constants.js');
  stubs['../net2/CommonKeys.js'] = require('../net2/CommonKeys.js');
  return proxyquire(`../sensor/${file}`, Object.assign(stubs, overrides));
}

describe('audit:dns retention', () => {
  it('OldDataCleanSensor trims audit:dns:* with the auditAccept retention', () => {
    const platform = {
      getRetentionCountMultiplier: () => 1, getRetentionTimeMultiplier: () => 1,
      getDNSFlowRetentionCountMultiplier: () => 1, getDNSFlowRetentionTimeMultiplier: () => 1,
    };
    const OldDataCleanSensor = loadSensor('OldDataCleanSensor.js', {
      '../platform/PlatformLoader.js': { getPlatform: () => platform },
    });
    const sensor = new OldDataCleanSensor({ auditAccept: { expires: 86400, count: 5000 } });
    sensor.filterFunctions = [];
    sensor.registerFilterFunctions();

    const typesFor = (key) => sensor.filterFunctions.filter(f => f.filterFunc(key)).map(f => f.type);
    expect(typesFor('audit:dns:system')).to.eql(['auditAccept']);
    expect(typesFor('audit:dns:AA:BB:CC:DD:EE:FF')).to.eql(['auditAccept']);
    expect(typesFor('audit:accept:AA:BB:CC:DD:EE:FF')).to.eql(['auditAccept']);
    expect(typesFor('audit:drop:AA:BB:CC:DD:EE:FF')).to.eql(['auditDrop']);
  });

  it('ACLAuditLogPlugin.mergeLogs compacts audit:dns:system on every run', async () => {
    const queried = [];
    const rclient = {
      zrangebyscoreAsync: async (key) => { queried.push(key); return []; },
      pipelineAndLog: async () => {},
    };
    const redisManager = { getRedisClient: () => rclient, getPublishClient: () => anything() };
    const ACLAuditLogPlugin = loadSensor('ACLAuditLogPlugin.js', { '../util/redis_manager.js': redisManager });
    const plugin = new ACLAuditLogPlugin({ interval: 300 });

    await plugin.mergeLogs(0, 300);
    expect(queried).to.include('audit:dns:system');

    // touchedKeys is reset after each merge, the next one must still cover audit:dns:system
    queried.length = 0;
    await plugin.mergeLogs(300, 600);
    expect(queried).to.include('audit:dns:system');
  });
});
