/*    Copyright 2025 Firewalla Inc.
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

let chai = require('chai');
let expect = chai.expect;

const rclient = require('../util/redis_manager').getRedisClient();
const config = require('../net2/config.js');
const FlowCompressionSensor = require('../sensor/FlowCompressionSensor');
const flowCompressionSensor = new FlowCompressionSensor(config.getConfig().sensors.FlowCompressionSensor);
const zlib = require('zlib');
const util = require('util');
const inflateAsync = util.promisify(zlib.inflate);
const delay = require('../util/util.js').delay;
const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();
const SPLIT_STRING = "\n";
const log = require('../net2/logger.js')(__filename);
const lm = require('../net2/LoggerManager.js');
const sysManager = require('../net2/SysManager.js');
const Constants = require('../net2/Constants.js');

describe('Test Flow Compression Sensor', function() {
  this.timeout(300000);

  before(async () => {
    lm.loggers['FlowCompressionSensor'].effectiveLogLevel = 'verbose';
    await hostManager.getHostsAsync();

    this.testStartTime = Date.now() / 1000;
    this.slotEnd = Math.floor(Date.now() / 1000 / flowCompressionSensor.step) * flowCompressionSensor.step
    this.slotBegin = this.slotEnd - flowCompressionSensor.step;
    log.info(`Testing time slot: now: ${this.testStartTime}, begin: ${this.slotBegin}, end: ${this.slotEnd}`);

    await flowCompressionSensor.globalOff();
    await rclient.setAsync(flowCompressionSensor.latestTsKey, this.slotBegin);
    await flowCompressionSensor.globalOn();
    while (await rclient.getAsync(flowCompressionSensor.buildingKey) == "1") {
      await delay(1000);
    }
    log.info("Flow compression sensor building done");
  });

  after(async () => {
    await flowCompressionSensor.globalOff();
  });

  describe('compare compressed flows with raw redis flows', () => {
    it('should match flow count between decompressed flows and raw redis flows for previous time slot', async () => {
      // Get the compressed flows key for this time slot
      const compressedKey = flowCompressionSensor.getKey(this.slotEnd);
      const compressedData = await rclient.getAsync(compressedKey);

      if (!compressedData) {
        log.warn(`No compressed data found for key ${compressedKey}, skipping test`);
        return;
      }

      // Decompress the flows
      let decompressedFlows = [];
      const compressedChunks = compressedData.split(SPLIT_STRING).filter(chunk => chunk.length > 0);

      for (const chunk of compressedChunks) {
        try {
          const base64Buffer = Buffer.from(chunk, 'base64');
          const inflatedBuffer = await inflateAsync(base64Buffer);
          const jsonStr = inflatedBuffer.toString('utf8');
          const flows = JSON.parse(jsonStr);
          decompressedFlows.push(...flows);
        } catch (e) {
          log.error(`Error decompressing chunk:`, e);
        }
      }

      log.info(`Decompressed ${decompressedFlows.length} flows from compressed key`);

      // Get all flow keys from Redis using a single SCAN, excluding system keys
      // Use SCAN with pattern '*' to get all keys, then filter for flow keys
      const allKeys = await rclient.scanResults('*');

      // Filter for flow keys and exclude system keys (keys ending with ":system")
      const isFlowKey = (key) => {
        return (key.startsWith('flow:conn:') && !key.endsWith(':00:00:00:00:00:00') ||
          key.startsWith('flow:local:') ||
          key.startsWith('audit:drop:') ||
          key.startsWith('audit:local:drop:')) &&
          !key.endsWith(':system') &&
          !key.includes(':if:');
      };

      const flowKeys = allKeys.filter(isFlowKey);

      let rawFlowCount = 0;

      // Query all flow keys
      // Note: Redis sorted sets use _ts as the score, so zrangebyscore already filters by timestamp
      for (const key of flowKeys) {
        try {
          const flows = await rclient.zrangebyscoreAsync(key, '(' + this.slotBegin, this.slotEnd);
          let flowCount = 0;
          for (const flowStr of flows) {
            try {
              const flow = JSON.parse(flowStr);
              // Flows are already filtered by timestamp via zrangebyscore
              flowCount += (flow.ct || 1);
            } catch (e) {
              log.debug(`Error parsing flow from ${key}:`, e);
            }
          }
          if (key.includes('local'))
            flowCount /= 2;
          rawFlowCount += flowCount;
        } catch (e) {
          log.debug(`Error querying ${key}:`, e);
        }
      }

      expect(decompressedFlows.reduce((acc, flow) => acc + (flow.count || 1), 0))
        .to.equal(rawFlowCount);
    });

    it('should match WAN block flow count between decompressed flows and raw redis flows', async () => {
      // Get the compressed WAN block flows
      const compressedData = await rclient.getAsync(flowCompressionSensor.wanCompressedFlowsKey);

      if (!compressedData) {
        log.warn(`No compressed WAN block data found, skipping test`);
        return;
      }

      // Decompress the WAN block flows
      let decompressedFlows = [];
      const compressedChunks = compressedData.split(SPLIT_STRING).filter(chunk => chunk.length > 0);

      for (const chunk of compressedChunks) {
        try {
          const base64Buffer = Buffer.from(chunk, 'base64');
          const inflatedBuffer = await inflateAsync(base64Buffer);
          const jsonStr = inflatedBuffer.toString('utf8');
          const flows = JSON.parse(jsonStr);
          decompressedFlows.push(...flows);
        } catch (e) {
          log.error(`Error decompressing chunk:`, e);
        }
      }

      log.info(`Decompressed ${decompressedFlows.length} WAN block flows from compressed key`);

      // Get WAN interface MACs
      const wanUUIDs = sysManager.getWanInterfaces().map(i => `${Constants.NS_INTERFACE}:${i.uuid}`);
      log.info(`Found ${wanUUIDs.length} WAN interfaces: ${wanUUIDs.join(', ')}`);

      if (wanUUIDs.length === 0) {
        log.warn(`No WAN interfaces found, skipping test`);
        return;
      }

      let safeBeginTime = this.testStartTime - 24*60*60;
      await Promise.all(wanUUIDs.map(async (uuid) => {
        const auditDropKey = `audit:drop:${uuid}`;
        const flows = await rclient.zrangebyscoreAsync(auditDropKey, 0, this.testStartTime, 'limit', 0, 1);
        if (flows && flows.length > 0)
          safeBeginTime = Math.max(safeBeginTime, JSON.parse(flows[0])._ts);
      }));

      log.info(`Query window: [${safeBeginTime}, ${this.testStartTime}]`);

      // Query raw flows from audit:drop keys for WAN interfaces from 0 to testStartTime
      // Find the earliest _ts from each WAN's results, then take the latest (maximum) across WANs
      let rawFlowCount = 0;
      
      for (const uuid of wanUUIDs) {
        const auditDropKey = `audit:drop:${uuid}`;
        try {
          // Query flows from 0 to test start time
          const flows = await rclient.zrangebyscoreAsync(auditDropKey, safeBeginTime, this.testStartTime);
          if (!flows || !flows.length) {
            log.warn(`No flows found for ${auditDropKey}, skipping`);
            continue;
          }

          for (const flowStr of flows) {
            try {
              const flow = JSON.parse(flowStr);
              rawFlowCount += (flow.ct || 1);
            } catch (e) {
              log.debug(`Error parsing flow from ${auditDropKey}:`, e);
            }
          }
        } catch (e) {
          log.debug(`Error querying ${auditDropKey}:`, e);
        }
      }

      log.info(`Found ${rawFlowCount} raw WAN block flows from Redis keys`);
      log.info(`Decompressed WAN block flows count: ${decompressedFlows.length}`);

      // Calculate decompressed flow count
      const decompressedFlowCount = decompressedFlows
        .filter(flow => flow.ts >= safeBeginTime && flow.ts < this.testStartTime)
        .reduce((acc, flow) => acc + (flow.count || 1), 0);

      log.info(`Decompressed flow count: ${decompressedFlowCount}, Raw flow count: ${rawFlowCount}`);

      // Compare counts - they should match
      expect(decompressedFlowCount).to.equal(rawFlowCount);
    });
  });
});

