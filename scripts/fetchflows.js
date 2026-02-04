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

const process = require('process')
const fsp = require('fs').promises

const log = require('../net2/logger.js')(__filename);
log.setGlobalLogLevel('warn')

const rclient = require('../util/redis_manager.js').getRedisClient();
const flowTool = require('../net2/FlowTool');
const Constants = require('../net2/Constants.js');
const TimeUsageTool = require('../flow/TimeUsageTool.js');
const _ = require('lodash');
const NoiseDomainsSensor = require('../sensor/NoiseDomainsSensor.js');
const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../vendor_lib/moment-tz-data.json'));
const DomainTrie = require('../util/DomainTrie.js');
const CIDRTrie = require('../util/CIDRTrie.js');
const { Address4, Address6 } = require('ip-address');

const domainTrie = new DomainTrie();
const cidr4Trie = new CIDRTrie(4);
const cidr6Trie = new CIDRTrie(6);
const sigMap = new Map();

// Parse time string to Unix timestamp
function parseTime(timeStr, timezone) {
  const hasDateSeparators = /[-:\s]/.test(timeStr);
  if (hasDateSeparators) {
    let dateMoment;
    if (timezone && moment.tz.zone(timezone)) {
      // Try common date formats with timezone
      const formats = [
        'YYYY-MM-DD HH:mm:ss',
        'YYYY-MM-DDTHH:mm:ss',
        'YYYY/MM/DD HH:mm:ss',
        'MM/DD/YYYY HH:mm:ss'
      ];
      let parsed = false;
      for (const format of formats) {
        dateMoment = moment.tz(timeStr, format, true, timezone);
        if (dateMoment.isValid()) {
          parsed = true;
          break;
        }
      }
      if (!parsed) {
        // Fallback to moment's default parsing
        dateMoment = moment.tz(timeStr, timezone);
      }
    } else {
      // No timezone or invalid timezone, use default Date parsing
      const date = new Date(timeStr);
      if (!isNaN(date.getTime())) {
        return Math.floor(date.getTime() / 1000);
      }
      throw new Error(`Invalid date format: ${timeStr}`);
    }
    
    if (dateMoment && dateMoment.isValid()) {
      return dateMoment.unix();
    }
    throw new Error(`Invalid date format: ${timeStr}`);
  }
  
  // Try as Unix timestamp (pure number)
  const timestamp = parseInt(timeStr, 10);
  if (!isNaN(timestamp) && timestamp > 0) {
    return timestamp;
  }
  
  throw new Error(`Invalid time format: ${timeStr}`);
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    mac: null,
    startTime: null,
    endTime: null,
    appName: 'internet',
    minMins: null
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mac' && i + 1 < args.length) {
      options.mac = args[i + 1];
      i++;
    } else if (args[i] === '--min' && i + 1 < args.length) {
      options.minMins = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--start' && i + 1 < args.length) {
      options.startTime = args[i + 1];
      i++;
    } else if (args[i] === '--end' && i + 1 < args.length) {
      options.endTime = args[i + 1];
      i++;
    } else if (args[i] === '--app' && i + 1 < args.length) {
      options.appName = args[i + 1];
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

// Print help message
function printHelp() {
  console.log('Usage: node fetchflows.js [--mac MAC_ADDRESS[,MAC2,...]] --start START_TIME --end END_TIME [--app APP_NAME] [--min MINS]');
  console.log('');
  console.log('Options:');
  console.log('  --mac MAC_ADDRESS    Device MAC address (optional). Multiple MACs separated by comma. If omitted, use all devices active since start time.');
  console.log('  --start START_TIME   Start time: Unix timestamp or date string (required)');
  console.log('  --end END_TIME       End time: Unix timestamp or date string (required)');
  console.log('  --app APP_NAME       App name (default: internet)');
  console.log('  --min MINS           Min activity time in minutes; skip output for device if total below this (optional)');
  console.log('  --help, -h           Show this help message');
  console.log('');
  console.log('Time format examples:');
  console.log('  Unix timestamp: 1698501600');
  console.log('  Date string: "2023-10-28 14:00:00" or "2023-10-28T14:00:00"');
  console.log('');
  console.log('Example:');
  console.log('  node fetchflows.js --start 1769083200 --end 1769788800');
  console.log('  node fetchflows.js --mac 6C:1F:F7:23:39:CB --start 1769083200 --end 1769788800');
  console.log('  node fetchflows.js --mac "6C:1F:F7:23:39:CB,AA:BB:CC:DD:EE:FF" --start "2026-01-22 20:00:00" --end "2026-01-31 00:00:00"');
}

// Validate arguments; mac is optional (omit to use all devices active since start); mac may be comma-separated
function validateArgs(options, timezone) {
  let macs = [];
  if (options.mac && typeof options.mac === 'string') {
    macs = options.mac.split(',').map(m => m.trim()).filter(m => m);
  }

  if (!options.startTime) {
    console.error('Error: Start time is required');
    console.error('Use --help for usage information');
    process.exit(1);
  }

  if (!options.endTime) {
    console.error('Error: End time is required');
    console.error('Use --help for usage information');
    process.exit(1);
  }

  let startTs, endTs;
  try {
    startTs = parseTime(options.startTime, timezone);
    endTs = parseTime(options.endTime, timezone);
  } catch (err) {
    console.error('Error parsing time:', err.message);
    process.exit(1);
  }

  if (startTs >= endTs) {
    console.error('Error: Start time must be before end time');
    process.exit(1);
  }

  let minMins = null;
  if (options.minMins != null && !isNaN(options.minMins) && options.minMins >= 0) {
    minMins = options.minMins;
  }

  return { startTs, endTs, macs, minMins };
}

// Get category bytes threshold from config
function getCategoryBytesThreshold(category, internet_time_usage_config) {
  if (internet_time_usage_config) {
    if (category && internet_time_usage_config[category] && 
      typeof internet_time_usage_config[category].bytesThreshold === "number") {
      return internet_time_usage_config[category].bytesThreshold;
    }
    if (internet_time_usage_config["default"] && 
      typeof internet_time_usage_config["default"].bytesThreshold === "number") {
      return internet_time_usage_config["default"].bytesThreshold;
    }
  }
  return 200 * 1024; // default threshold is 200KB
}

// Get category ul/dl ratio threshold from config
function getCategoryUlDlRatioThreshold(category, internet_time_usage_config) {
  if (internet_time_usage_config) {
    if (category && internet_time_usage_config[category] && 
      typeof internet_time_usage_config[category].ulDlRatioThreshold === "number") {
      return internet_time_usage_config[category].ulDlRatioThreshold;
    }
    if (internet_time_usage_config["default"] && 
      typeof internet_time_usage_config["default"].ulDlRatioThreshold === "number") {
      return internet_time_usage_config["default"].ulDlRatioThreshold;
    }
  }
  return 5; // default threshold is 5
}

// Get category background download config from config
function getCategoryBackgroundDownload(category, internet_time_usage_config) {
  if (internet_time_usage_config) {
    if (category &&
      internet_time_usage_config[category] &&
      typeof internet_time_usage_config[category].backgroundDownload === "object") {
      return internet_time_usage_config[category].backgroundDownload;
    }
    if (internet_time_usage_config["default"] &&
      typeof internet_time_usage_config["default"].backgroundDownload === "object") {
      return internet_time_usage_config["default"].backgroundDownload;
    }
  }
  return {};
}

// Check if flow is background download
function isBackgroundDownload(flow, backgroundDownload) {
  if (_.isEmpty(backgroundDownload) || !backgroundDownload.minDuration || !backgroundDownload.minDownloadRate)
    return false;

  const count = flow.count || 1;
  const duration = (flow.duration || flow.du || 0.1) / count;
  // flow.rb is download, flow.ob is upload in original format
  // flow.download and flow.upload in simplified format
  const download = (flow.download || flow.rb || 0) / count;
  const upload = (flow.upload || flow.ob || 0) / count;
  const downloadRate = download / duration;
  const uploadRate = upload / duration;
  if (duration >= backgroundDownload.minDuration 
    && downloadRate >= backgroundDownload.minDownloadRate
    && uploadRate <= backgroundDownload.maxUploadRate) {
    return true;
  }
  return false;
}


async function rebuildTrie() {
  const appTimeUsageConfig = await rclient.getAsync(Constants.REDIS_KEY_APP_TIME_USAGE_CLOUD_CONFIG).then(result => result && JSON.parse(result)).catch(err => null);
  const appConfs = Object.assign({}, _.get(appTimeUsageConfig, "appConfs", {}));

  for (const key of Object.keys(appConfs)) {
    const includedDomains = appConfs[key].includedDomains || [];
    const category = appConfs[key].category;
    for (const value of includedDomains) {
      const obj = _.pick(value, ["occupyMins", "lingerMins", "bytesThreshold", "minsThreshold", "ulDlRatioThreshold", "noStray", "portInfo", "backgroundDownload"]);
      obj.app = key;
      if (category)
        obj.category = category;

      const id = value.domain || value.cidr;
      if (id) {
        if (new Address4(id).isValid()) {
          obj.domain = id;
          cidr4Trie.add(id, obj);
        } else if (new Address6(id).isValid()) {
          obj.domain = id;
          cidr6Trie.add(id, obj);
        } else {
          if (id.startsWith("*.")) {
            obj.domain = id.substring(2);
            domainTrie.add(id.substring(2), obj);
          } else {
            obj.domain = id;
            domainTrie.add(id, obj, false);
          }
        }
      }
      const sigId = value.sigId;
      if (sigId) {
        sigMap.set(sigId, obj);
      }
    }
    // use !<app_key> to mark a domain is excluded from an app
    const excludedDomains = appConfs[key].excludedDomains || [];
    for (const domain of excludedDomains) {
      if (domain.startsWith("*.")) {
        domainTrie.add(domain.substring(2), `!${key}`);
      } else {
        domainTrie.add(domain, `!${key}`, false);
      }
    }
  }
}
function getInternetOptions(internetTimeUsageCfg) {
  const defaultCfg = (internetTimeUsageCfg && internetTimeUsageCfg["default"]) || {};
  const {
    occupyMins = 1,
    lingerMins = 10,
    minsThreshold = 1,
    noStray = true
  } = defaultCfg;

  return {
    app: "internet",
    occupyMins,
    lingerMins,
    minsThreshold,
    noStray
  };
}

function isMatchPortInfo(portInfo, port, proto) {
  // if portInfo is empty, it means no port restriction
  if (!portInfo || _.isEmpty(portInfo)) return true;

  return _.some(portInfo, (pinfo) => {
    const startPort = parseInt(pinfo.start);
    const endPort = parseInt(pinfo.end);
    if (isNaN(startPort) || isNaN(endPort) || startPort < 0 || endPort < 0 || startPort > endPort)
      return false;
    return (!pinfo.proto || pinfo.proto === proto) && port >= startPort && port <= endPort;
  });
}

function isBackgroundDownload(flow, backgroundDownload) {
  if (_.isEmpty(backgroundDownload) || !backgroundDownload.minDuration || !backgroundDownload.minDownloadRate)
    return false;
  const duration = flow.du || 0.1;
  const downloadRate = (flow.download || flow.rb || 0) / duration;
  const uploadRate = (flow.upload || flow.ob || 0) / duration;
  if (duration >= backgroundDownload.minDuration
    && downloadRate >= backgroundDownload.minDownloadRate
    && uploadRate <= backgroundDownload.maxUploadRate) {
    // recordFlow2Redis(flow, "background");
    return true;
  }
  return false;
}

function lookupAppMatch(flow, internetTimeUsageCfg, noiseDomainsSensor) {
  const host = flow.host || flow.intel && flow.intel.host;
  const ip = flow.ip || (flow.intel && flow.intel.ip) || "";
  const sigs = flow.sigs || [];
  const result = [];
  let internet_options = getInternetOptions(internetTimeUsageCfg)
  if ((!domainTrie && !cidr4Trie && !cidr6Trie && !sigMap) || (!host && !ip))
    return result;
  // check domain trie
  const values = domainTrie.find(host);
  let isAppMatch = false;
  if (_.isSet(values)) {
    for (const value of values) {
      if (_.isObject(value) && value.app && !values.has(`!${value.app}`)) {
        if (!isMatchPortInfo(value.portInfo, flow.dp, flow.pr))
          continue;
        isAppMatch = true;
        if ((!value.bytesThreshold || flow.upload + flow.download >= value.bytesThreshold)
          && (!value.ulDlRatioThreshold || flow.upload <= value.ulDlRatioThreshold * flow.download)
          && !isBackgroundDownload(flow, value.backgroundDownload)) {
          result.push(value);
          // keep internet options same as the matched app
          Object.assign(internet_options, {
            occupyMins: value.occupyMins,
            lingerMins: value.lingerMins,
            minsThreshold: value.minsThreshold,
            noStray: value.noStray
          });
          break;
        }
      }
    }
  }

  // check cidr trie
  let cidrTrie = new Address4(ip).isValid() ? cidr4Trie : cidr6Trie;
  if (_.isEmpty(result) && cidrTrie) {
    const entry = cidrTrie.find(ip);
    if (_.isObject(entry)) {
      if (isMatchPortInfo(entry.portInfo, flow.dp, flow.pr)) {
        isAppMatch = true;
        if ((!entry.bytesThreshold || flow.upload + flow.download >= entry.bytesThreshold)
          && (!entry.ulDlRatioThreshold || flow.upload <= entry.ulDlRatioThreshold * flow.download)
          && !isBackgroundDownload(flow, entry.backgroundDownload)) {
          result.push(entry);
          // keep internet options same as the matched app
          Object.assign(internet_options, {
            occupyMins: entry.occupyMins,
            lingerMins: entry.lingerMins,
            minsThreshold: entry.minsThreshold,
            noStray: entry.noStray
          });
        }
      }
    }
  }

  // check sigs
  if (_.isEmpty(result) && sigMap.size > 0) {
    for (const sigId of sigs) {
      const entry = sigMap.get(sigId);
      if (_.isObject(entry)) {
        isAppMatch = true;
        if ((!entry.bytesThreshold || flow.upload + flow.download >= entry.bytesThreshold)
          && (!entry.ulDlRatioThreshold || flow.upload <= entry.ulDlRatioThreshold * flow.download)
          && (!isBackgroundDownload(flow, entry.backgroundDownload))) {
          result.push(entry);
          // keep internet options same as the matched app
          Object.assign(internet_options, {
            occupyMins: entry.occupyMins,
            lingerMins: entry.lingerMins,
            minsThreshold: entry.minsThreshold,
            noStray: entry.noStray
          });
        }
      }
    }
  }

  if (isAppMatch && _.isEmpty(result)) {
    return result;
  }
  // match internet activity on flow
  const category = _.get(flow, ["intel", "category"]);
  const upload = flow.upload || flow.ob || 0;
  const download = flow.download || flow.rb || 0;
  let count = flow.count || 1;
  if (count > 3) {
    // 4->3, 10->4, 16->6
    count = Math.floor(Math.sqrt(count) * 1.5);
  }
  const bytesThreshold = getCategoryBytesThreshold(category, internetTimeUsageCfg);
  // ignore flows with large upload/download ratio, e.g., a flow with large ul/dl ratio may happen if device is backing up data
  const ulDlRatioThreshold = getCategoryUlDlRatioThreshold(category, internetTimeUsageCfg);
  const backgroundDownload = getCategoryBackgroundDownload(category, internetTimeUsageCfg);
  const nds = noiseDomainsSensor;
  let flowNoiseTags = nds ? nds.find(host) : null;

  if ((upload + download >= bytesThreshold * count
    && upload <= ulDlRatioThreshold * download 
    && _.isEmpty(flowNoiseTags) 
    && !isBackgroundDownload(flow, backgroundDownload)) || !_.isEmpty(result)) {
    result.push(internet_options);
    log.debug("match internet activity on flow", flow, `bytesThreshold: ${bytesThreshold}`);
  }
  return result;
}

function lookupAppMatchFlows(flows, internet_time_usage_config, noiseDomainsSensor, appName) {
  if (!flows || !Array.isArray(flows)) {
    return [];
  }
  if (!internet_time_usage_config || !noiseDomainsSensor) {
    console.log(`Failed to get internet_time_usage_config and noiseDomainsSensor\n`);
    return [];
  }
  if (appName == null || appName === '') {
    appName = 'internet';
  }
  const matchedFlowsMap = {};
  for (const flow of flows) {
    const appMatches = lookupAppMatch(flow, internet_time_usage_config, noiseDomainsSensor);
    if (_.isEmpty(appMatches))
      continue;

    for (const match of appMatches) {
      const app = match.app || 'internet';
      if (!matchedFlowsMap[app]) {
        matchedFlowsMap[app] = [];
      }
      matchedFlowsMap[app].push(Object.assign({}, flow, { app: app }));
    }
  }
  return matchedFlowsMap[appName] || [];
}

// Temporary helper for step-through debugging: load flows from /tmp/testflows.json and run lookupAppMatchFlows
async function testLookupAppMatchFlows(internet_time_usage_config, noiseDomainsSensor, appName) {
  const testPath = '/tmp/testflows.json';
  let flows = [];
  try {
    const data = await fsp.readFile(testPath, 'utf8');
    const parsed = JSON.parse(data);
    flows = Array.isArray(parsed) ? parsed : (parsed.data && Array.isArray(parsed.data.flows) ? parsed.data.flows : (parsed.flows || parsed.data || []));
  } catch (e) {
    log.warn('testLookupAppMatchFlows: read or parse failed', testPath, e.message);
    return;
  }
  if (!flows.length) {
    log.warn('testLookupAppMatchFlows: no flows in', testPath);
    return;
  }
  const matched = lookupAppMatchFlows(flows, internet_time_usage_config, noiseDomainsSensor, appName);
  console.log('testLookupAppMatchFlows: input flows=%d, matched for appName=%s: %d', flows.length, appName || 'internet', matched.length);
}

async function fetchFlowsForMac(mac, startTs, endTs, appName, timezone, internet_time_usage_config, noiseDomainsSensor) {
  const baseOptions = {
    begin: startTs ,
    end: endTs + 180,  // consider 3 minutes delay for flow record to redis
    asc: true
  };

  const flowOptions = {
    ...baseOptions,
    mac: mac,
    regular: true,
    audit: false,
    localAudit: false,
    type: "host",
    apiVer: 2,
  };

  const allFlows = [];
  let completed = false;
  let currentOptions = JSON.parse(JSON.stringify(flowOptions));

  while (!completed) {
    try {
      const flows = await flowTool.prepareRecentFlows(currentOptions) || [];
      if (!flows.length) {
        completed = true;
        break;
      }
      allFlows.push(...flows);
      const lastTs = flows[flows.length - 1].ts;

      if (lastTs >= endTs) {
        completed = true;
        break;
      }

      if (flows.length < currentOptions.count) {
        completed = true;
      } else {
        currentOptions.ts = lastTs;
      }
    } catch (e) {
      log.error(`Load flows error`, e);
      completed = true;
    }
  }

  const matchedFlows = lookupAppMatchFlows(allFlows, internet_time_usage_config, noiseDomainsSensor, appName);
  return matchedFlows;
}

function printMatchedFlows(matchedFlows, mac, timezone, localDomain) {
  const localStr = (localDomain != null && localDomain !== '') ? String(localDomain) : '-';
  console.log(`\n=== Matched Flows (MAC: ${mac}) [Host: ${localStr}] ===`);
  console.log(`Total matched flows: ${matchedFlows.length}\n`);

  if (matchedFlows.length === 0) return;

  const colWidths = {
    ts: 19,
    count: 5,
    duration: 8,
    proto: 6,
    port: 6,
    devicePort: 10,
    ip: 16,
    deviceIP: 16,
    upload: 12,
    download: 12,
    total_average: 13,
    device: 17,
    app: 8,
    host: 40
  };

  const header = [
    'ts'.padEnd(colWidths.ts),
    'count'.padEnd(colWidths.count),
    'duration'.padEnd(colWidths.duration),
    'proto'.padEnd(colWidths.proto),
    'port'.padEnd(colWidths.port),
    'devicePort'.padEnd(colWidths.devicePort),
    'ip'.padEnd(colWidths.ip),
    'deviceIP'.padEnd(colWidths.deviceIP),
    'upload'.padEnd(colWidths.upload),
    'download'.padEnd(colWidths.download),
    'total_average'.padEnd(colWidths.total_average),
    'device'.padEnd(colWidths.device),
    'app'.padEnd(colWidths.app),
    'host'.padEnd(colWidths.host)
  ].join(' | ');

  console.log(header);
  console.log('-'.repeat(header.length));

  for (const flow of matchedFlows) {
    const ts = flow.ts || flow._ts || 0;
    const readableTime = timezone
      ? moment.unix(ts).tz(timezone).format('YYYY-MM-DD HH:mm:ss')
      : moment.unix(ts).format('YYYY-MM-DD HH:mm:ss');
    const tsStr = `${readableTime}`.substring(0, colWidths.ts);

    const upload = flow.upload || flow.ob || 0;
    const download = flow.download || flow.rb || 0;
    const count = flow.count || 1;
    const total_average = count > 0 ? Math.round((upload + download) / count) : 0;

    const uploadKB = (upload / 1024).toFixed(2);
    const downloadKB = (download / 1024).toFixed(2);
    const total_averageKB = (total_average / 1024).toFixed(2);

    const appStr = String(flow.app || 'internet').substring(0, colWidths.app);
    const row = [
      tsStr.padEnd(colWidths.ts),
      String(count).padEnd(colWidths.count),
      String(flow.duration || flow.du || 0).padEnd(colWidths.duration),
      String(flow.protocol || flow.pr || '').padEnd(colWidths.proto),
      String(flow.port || flow.dp || '').padEnd(colWidths.port),
      String(flow.devicePort || (Array.isArray(flow.sp) ? flow.sp[0] : flow.sp) || '').padEnd(colWidths.devicePort),
      String(flow.ip || flow.dh || '').padEnd(colWidths.ip),
      String(flow.deviceIP || flow.sh || '').padEnd(colWidths.deviceIP),
      `${uploadKB} KB`.padEnd(colWidths.upload),
      `${downloadKB} KB`.padEnd(colWidths.download),
      `${total_averageKB} KB`.padEnd(colWidths.total_average),
      String(flow.device || flow.mac || '').padEnd(colWidths.device),
      appStr.padEnd(colWidths.app),
      String(flow.host || (flow.intel && flow.intel.host) || '').substring(0, colWidths.host).padEnd(colWidths.host)
    ].join(' | ');

    console.log(row);
  }
  console.log('');
}

function printInternetActivity(stats, mac, timezone) {
  if (stats.devices && Object.keys(stats.devices).length > 0) {
    for (const device of Object.keys(stats.devices)) {
      console.log(`\nNetwork Activity for Device: ${device}`);
      for (const interval of stats.devices[device].intervals) {
        const duration = Math.ceil((interval.end - interval.begin) / 60 + 1);
        const fromStr = timezone
          ? moment.unix(interval.begin).tz(timezone).format('YYYY-MM-DD HH:mm:ss')
          : moment.unix(interval.begin).format('YYYY-MM-DD HH:mm:ss');
        const toStr = timezone
          ? moment.unix(interval.end).tz(timezone).format('YYYY-MM-DD HH:mm:ss')
          : moment.unix(interval.end).format('YYYY-MM-DD HH:mm:ss');
        console.log(`  From ${fromStr} to ${toStr}, Duration: ${duration} mins`);
      }
    }
  }
  console.log(`Total Minutes: ${stats.totalMins}`);
  console.log('\n----------------------------------------------------------');
}

// from Redis sorted set host:active:mac, score = last activity time
async function fetchActiveDevices(startTs) {
  const macs = await rclient.zrevrangebyscoreAsync(Constants.REDIS_KEY_HOST_ACTIVE, '+inf', startTs) || [];
  return macs.filter(Boolean);
}

// Returns { mac, stats, totalMins } or null. minMins: if set, return null when totalMins < minMins. appName defaults to 'internet'.
async function fetchInternetActivityForMac(mac, startTs, endTs, timezone, minMins, localDomain, appName) {
  if (appName == null || appName === '') {
    appName = 'internet';
  }
  const granularity = 'hour';
  const uidIsDevice = true;
  const includeSlots = true;
  const includeIntervals = true;
  const outputApps = [appName];

  const stats = await TimeUsageTool.getAppTimeUsageStats(
    mac, null, outputApps, startTs, endTs, granularity, uidIsDevice, includeSlots, includeIntervals
  );

  const appTimeUsage = _.get(stats, ['appTimeUsage', appName]);
  if (!appTimeUsage) {
    return null;
  }
  if (appTimeUsage.totalMins > 0) {
    console.log(`Fetched ${appName} activity for MAC: ${mac}, Host: ${localDomain}, Total Minutes: ${appTimeUsage.totalMins}`);
  }

  if ((minMins != null && appTimeUsage.totalMins < minMins) || appTimeUsage.totalMins === 0) {
    return null;
  }

  return {
    mac: mac,
    localDomain: localDomain,
    stats: appTimeUsage,
    totalMins: appTimeUsage.totalMins
  };
}

// Main function
async function main() {
  try {
    const timezone = await rclient.hgetAsync("sys:config", "timezone");

    const options = parseArgs();
    let { startTs, endTs, macs, minMins } = validateArgs(options, timezone);
    const { appName } = options;

    const configStr = await rclient.getAsync('internet_time_usage_config');
    const internet_time_usage_config = configStr ? JSON.parse(configStr) : null;

    const noiseDomainsSensor = new NoiseDomainsSensor();
    await noiseDomainsSensor.loadLocalNoiseDomainData4Test();

    await rebuildTrie();

    // await testLookupAppMatchFlows(internet_time_usage_config, noiseDomainsSensor, appName);
    if (!macs || macs.length === 0) {
      macs = await fetchActiveDevices(startTs);
      if (macs.length === 0) {
        console.log('No devices with activity since start time.');
        process.exit(0);
      }
    }

    const resultList = [];
    for (const mac of macs) {
      let localDomain = '';
      try {
        const v = await rclient.hgetAsync(`host:mac:${mac}`, 'localDomain');
        if (v != null && typeof v === 'string') localDomain = v;
      } catch (e) {
        log.warn(`Failed to get local_domain for host:mac:${mac}`, e.message);
      }
      const activityItem = await fetchInternetActivityForMac(mac, startTs, endTs, timezone, minMins, localDomain, appName);
      if (activityItem != null) {
        const allFlows = [];
        const devices = activityItem.stats.devices || {};
        for (const deviceKey of Object.keys(devices)) {
          const intervals = devices[deviceKey].intervals;
          if (!Array.isArray(intervals)) continue;
          for (const interval of intervals) {
            const flows = await fetchFlowsForMac(mac, interval.begin, interval.end, appName, timezone, internet_time_usage_config, noiseDomainsSensor);
            allFlows.push(...flows);
          }
        }
        const matchedFlows = _.uniqBy(allFlows, (f) => {
              const ts = (f.ts != null) ? f.ts : ((f._ts != null) ? f._ts : 0);
              const dh = (f.dh != null) ? f.dh : ((f.ip != null) ? f.ip : '');
              const dp = (f.dp != null) ? f.dp : ((f.port != null) ? f.port : '');
              const sh = (f.sh != null) ? f.sh : ((f.deviceIP != null) ? f.deviceIP : '');
              const sp = Array.isArray(f.sp) ? f.sp[0] : ((f.sp != null) ? f.sp : ((f.devicePort != null) ? f.devicePort : ''));
              return `${ts}_${dh}_${dp}_${sh}_${sp}`;
            });
        activityItem.matchedFlows = matchedFlows;
        resultList.push(activityItem);
      }
    }

    resultList.sort((a, b) => b.totalMins - a.totalMins);

    for (const item of resultList) {
      printMatchedFlows(item.matchedFlows, item.mac, timezone, item.localDomain);
      printInternetActivity(item.stats, item.mac, timezone);
    }

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
