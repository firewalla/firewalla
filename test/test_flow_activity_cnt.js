/*    Copyright 2016-2025 Firewalla Inc.
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


/*
Usage:
  
MOCK_MODE=true \
FLOW_PATH=/home/pi/bak/flows-0819 \
START_TIME="8/19/2025, 10:00:00" \
END_TIME="8/19/2025, 23:00:00" \
npx mocha test/test_flow_activity_cnt.js --exit
*/

'use strict'

const chai = require('chai');
const expect = chai.expect;
const _ = require('lodash');
const fsp = require('fs').promises;
const path = require('path');
const rclient = require('../util/redis_manager.js').getRedisClient();
const mock = require('mock-require');
setupMocks();

const proxyquire = require('proxyquire');
const realTimeUsageTool = proxyquire.noPreserveCache().load('../flow/TimeUsageTool.js', {
  '../net2/Firewalla.js': {
    isMain: () => true,
    isApi: () => false
  }
});
const TimeUsageToolClass = Object.getPrototypeOf(realTimeUsageTool).constructor;
const realTimeUsageToolInstance = new TimeUsageToolClass();
realTimeUsageToolInstance.getHourKey = (uid, app, hour) => { return `mock:timeUsage:${uid}:app:${app}:${hour}`; };
const AppTimeUsageSensor = proxyquire('../sensor/AppTimeUsageSensor.js', {
  '../flow/TimeUsageTool.js': realTimeUsageToolInstance
});

let appTimeUsageSensor = new AppTimeUsageSensor({});
appTimeUsageSensor.loadConfig(false);

const flowTool = require('../net2/FlowTool');
const sensorLoader = require('../sensor/SensorLoader.js');

const flowPath = process.env.FLOW_PATH || '/home/pi/bak/flows-0819';
let startTime = process.env.START_TIME || "2025-08-19 00:00:00";
let endTime = process.env.END_TIME || "2025-08-20 00:00:00";

let deviceNetworkActivityMap = new Map();


function getDeviceName(mac) {
  const macDeviceMap = {
    "5E:39:71:B9:3B:B8": "Chris's MacBook Air",
    "CE:CF:AF:60:5A:B4": "Matt's MacBook Pro",
    "52:32:59:38:B0:B5": "Annie Office iMac",
    "C4:35:D9:98:3F:13": "Melvin's MacBook Air",
    "0E:0F:B6:05:F8:A9": "Rebecca's MacBook Air",
    "B0:8C:75:E2:08:33": "FirewalasiPhone",
    "80:74:84:67:47:D3":"(US)android-1d7c51edaa499e91",
    "5E:35:21:95:AA:10":"(US)Jerry’s Mac mini (9)",
    "FC:B0:DE:04:9C:E3":"(US)dell-desktop",
    "D0:C9:07:C8:6C:58":"(US)Govee Air Monitor"
  };
  return macDeviceMap[mac] || mac;
}

async function loadNoiseDomainsSensor() {
  let noisedomain = ["marketplace.jetbrains.com", "fe2.apple-dns.net"];
  // noisedomain = [];
  const nds = await sensorLoader.initSingleSensor("NoiseDomainsSensor");
  await nds.reloadDomains(false);
  noisedomain.forEach(domain => {
    nds.bloomfilter.add(domain);
  });
  return nds;
}

function modifyAppTimeUsageSensorConfig() {
  appTimeUsageSensor.internetTimeUsageCfg["default"] = {
    "bytesThreshold": 204800,
    "ulDlRatioThreshold": 5
  }
}

function setupMocks() {
  const mockMode = process.env.MOCK_MODE === 'true';
  if (!mockMode) return;
  mock('../net2/logger.js', () => ({
    verbose: () => { },
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
    forceInfo: () => { }
  }));
}
async function clearRedisKeys() {
  const keyList = await rclient.scanResults(`mock:*`);
  for (const key of keyList) {
    await rclient.delAsync(key).catch(() => undefined);
  }
}

function convertTimeToTimestamp() {
  let start;
  let end;
  if (startTime.includes("-") || startTime.includes(":")) {
    start = new Date(startTime).getTime() / 1000;
  }
  if (endTime.includes("-") || endTime.includes(":")) {
    end = new Date(endTime).getTime() / 1000;
  }
  if (startTime === null || startTime === "") {
    start = new Date().setHours(0, 0, 0, 0) / 1000;
  }
  if (endTime === null || endTime === "" || endTime < startTime) {
    end = new Date().getTime() / 1000;
  }
  return { start, end };
}

async function loadFlowsFromFile(filename) {
  try {
    const content = await fsp.readFile(filename, 'utf8');
    const lines = content.trim().split('\n');
    const flows = lines.map(line => {
      try {
        if (line.trim() === '') {
          return null;
        }
        return JSON.parse(line);
      } catch (e) {
        console.error(`Error parsing JSON on line: "${line}"`, e);
        return null;
      }
    }).filter(flow => flow !== null);
    return flows;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    } else {
      throw err;
    }
  }
}

async function loadFlowsFromDirectory(pathname) {
  try {
    const files = await fsp.readdir(pathname);
    for (const file of files) {
      if (file.endsWith('.swp')) continue;
      const filePath = path.join(pathname, file);
      const stats = await fsp.stat(filePath);
      if (stats.isFile()) {
        const flows = await loadFlowsFromFile(filePath);
        deviceNetworkActivityMap.set(file, flows);
      }
    }
  } catch (err) {
    console.warn(`Cannot read directory ${pathname}:`);
  }
}

function getAllAppMatches(flows) {
  const appMatches = [];
  const { start, end } = convertTimeToTimestamp();
  flows.forEach(flow => {
    const flowval = flow.flow;
    if (flowval.ts < start || flowval.ts + flowval.du > end) {
      return;
    }
    const result = appTimeUsageSensor.lookupAppMatch(flowval);
    if (result.length > 0) {
      result.forEach(item => {
        appMatches.push(JSON.stringify({
          beginTime: flowval.ts,
          endTime: flowval.ts + flowval.du,
          duration: flowval.du,
          intf: flowval.intf,
          sourceMac: flowval.mac,
          destination: flowval.host || flowval.intel && flowval.intel.host,
          category: _.get(flowval, ["intel", "category"]) || "",
          app: item.app,
          tags: item.tags || [],
          upload: flowval.ob,
          download: flowval.rb,
          total: flowval.ob + flowval.rb,
          flowCount: 1, // this is a single flow, so count is 1
          occupyMins: item.occupyMins,
          lingerMins: item.lingerMins,
          bytesThreshold: item.bytesThreshold,
          minsThreshold: item.minsThreshold,
          noStray: item.noStray || false,
        }));
      });
    }
  });
  return appMatches;
}

function summarizeAppMatchesDestination(appMatches) {
  const summary = {};
  appMatches.forEach(appMatch => {
    const appMatchObj = JSON.parse(appMatch);
    const destination = appMatchObj.destination;
    if (!summary[destination]) {
      summary[destination] = {
        count: 0,
        details: []
      };
    }
    summary[destination].count += 1;
    summary[destination].details.push({
      beginTime: appMatchObj.beginTime,
      upload: appMatchObj.upload,
      download: appMatchObj.download,
      total: appMatchObj.total
    });
    summary[destination].details.sort((a, b) => a.beginTime - b.beginTime);
  });
  const summaryArray = Object.entries(summary).map(([destination, data]) => ({
    destination,
    count: data.count,
    details: data.details
  }));
  summaryArray.sort((a, b) => b.count - a.count);
  return summaryArray;
}

describe('Should verify the device network activity is calculated correctly.', function () {
  const mockMode = process.env.MOCK_MODE === 'true';

  before(async function () {
    this.timeout(60000);
    await loadNoiseDomainsSensor();
    await loadFlowsFromDirectory(flowPath);
  })

  after(async () => {
    await clearRedisKeys();
  });

  it.only('should output AppMatches statistics correctly', async function () {
    modifyAppTimeUsageSensorConfig();
    deviceNetworkActivityMap.forEach((flows, filename) => {
      const appMatches = getAllAppMatches(flows);

      const mac = filename.split('-')[0].replace(/_/g, ':');
      const date = filename.split('-')[1].replace('.json', '');
      const deviceInfo = `${getDeviceName(mac)} ${date}`;
      console.log(`\nDevice: \x1b[32m${filename} (${deviceInfo})\x1b[0m`);
      console.log('Network Activity Summary:\n');
      console.log(`Time\tDuration\tDestination\tTotal\nCategory\t`);
      appMatches.forEach(appMatch => {
        const appMatchObj = JSON.parse(appMatch);
        console.log(`${new Date(appMatchObj.beginTime * 1000).toLocaleString('en-US', { hour12: false })}\t${appMatchObj.duration}s\t${appMatchObj.destination}\t${(appMatchObj.total / 1024).toFixed(2)} KB\t${appMatchObj.category}`);
      });
      const summary = summarizeAppMatchesDestination(appMatches);
      //Destination-based statistics
      console.log(`\nDestination-based statistics:`);
      summary.forEach((item) => {
        const destination = item.destination;
        const data = item;
        console.log(`  Destination: \x1b[32m${destination}\x1b[0m`);
        console.log(`    Count: ${data.count}`);
        console.log(`    Details: ${data.details.map(detail => `${new Date(detail.beginTime * 1000).toLocaleString('en-US', { hour12: false })} ${(detail.total / 1024).toFixed(2)} KB`).join(', ')}`);
      });
      console.log(`\n----------------------------------------------------------`);
    });
  });

  it.only('should process EnrichedFlow correctly', async function () {
    this.timeout(20000);
    modifyAppTimeUsageSensorConfig();
    await appTimeUsageSensor.globalOn();

    const devices = new Set();

    for (const [device, flows] of deviceNetworkActivityMap.entries()) {
      for (const flow of flows) {
        await appTimeUsageSensor.processEnrichedFlow(flow.flow);
        if (flow.flow.mac) devices.add(flow.flow.mac);
      }
    }

    for (const mac of devices) {
      const uid = mac;

      const { start, end } = convertTimeToTimestamp();
      const apps = ["internet"];
      const granularity = "hour";
      const uidIsDevice = true;
      const includeSlots = true;
      const includeIntervals = true;

      const stats = await realTimeUsageToolInstance.getAppTimeUsageStats(
        uid, null, apps, start, end, granularity, uidIsDevice, includeSlots, includeIntervals
      );

      const internetTimeUsage = _.get(stats, ["appTimeUsage", "internet"]);
      if (!internetTimeUsage) {
        console.warn(`No internet usage data found for device: ${getDeviceName(uid)}`);
        continue;
      }

      console.log(`\nInternet Time Usage Statistics for device: \x1b[32m${getDeviceName(uid)}\x1b[0m`);
      const slots = internetTimeUsage.slots;

      for (const [timestamp, { totalMins }] of Object.entries(slots)) {
        if (totalMins > 0) {
          const readableTime = new Date(Number(timestamp) * 1000)
            .toLocaleString("en-US", { hour12: false });
          console.log(`Time: ${readableTime}, Total Minutes: ${totalMins}`);
        }
      }

      if (internetTimeUsage.devices && Object.keys(internetTimeUsage.devices).length > 0) {
        for (const device of Object.keys(internetTimeUsage.devices)) {
          console.log(`\nNetwork Activity for Device: ${device}`);
          for (const interval of internetTimeUsage.devices[device].intervals) {
            const duration = Math.ceil((interval.end - interval.begin) / 60 + 1);
            console.log(`  From ${new Date(interval.begin * 1000).toLocaleString('en-US', { hour12: false })} to ${new Date(interval.end * 1000).toLocaleString('en-US', { hour12: false })}, Duration: ${duration} mins`);
          }
        }
      }
      console.log(`Total Minutes: ${internetTimeUsage.totalMins}`);
      console.log(`\n----------------------------------------------------------`);

      expect(internetTimeUsage).to.have.property('totalMins').that.is.a('number');
    }
  });

});