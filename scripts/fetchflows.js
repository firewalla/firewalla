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

const log = require('../net2/logger.js')(__filename);
log.setGlobalLogLevel('warn')

const rclient = require('../util/redis_manager.js').getRedisClient();
const flowTool = require('../net2/FlowTool');
const _ = require('lodash');
const NoiseDomainsSensor = require('../sensor/NoiseDomainsSensor.js');
const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../vendor_lib/moment-tz-data.json'));
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
    appName: 'internet'
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mac' && i + 1 < args.length) {
      options.mac = args[i + 1];
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
  console.log('Usage: node fetchflows.js --mac MAC_ADDRESS --start START_TIME --end END_TIME [--app APP_NAME]');
  console.log('');
  console.log('Options:');
  console.log('  --mac MAC_ADDRESS    Device MAC address (required)');
  console.log('  --start START_TIME   Start time: Unix timestamp or date string (required)');
  console.log('  --end END_TIME       End time: Unix timestamp or date string (required)');
  console.log('  --app APP_NAME       App name (default: internet)');
  console.log('  --help, -h           Show this help message');
  console.log('');
  console.log('Time format examples:');
  console.log('  Unix timestamp: 1698501600');
  console.log('  Date string: "2023-10-28 14:00:00" or "2023-10-28T14:00:00"');
  console.log('');
  console.log('Example:');
  console.log('  node fetchflows.js --mac 6C:1F:F7:23:39:CB --start 1769083200 --end 1769788800');
  console.log('  node fetchflows.js --mac 6C:1F:F7:23:39:CB --start "2026-01-22 20:00:00" --end "2026-01-31 00:00:00"');
}

// Validate arguments
function validateArgs(options, timezone) {
  if (!options.mac) {
    console.error('Error: MAC address is required');
    console.error('Use --help for usage information');
    process.exit(1);
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

  return { startTs, endTs };
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
  // flow.du is duration in original format, flow.duration in simplified format
  const duration = flow.duration || flow.du || 0.1;
  // flow.rb is download, flow.ob is upload in original format
  // flow.download and flow.upload in simplified format
  const download = flow.download || flow.rb || 0;
  const upload = flow.upload || flow.ob || 0;
  const downloadRate = download / duration;
  const uploadRate = upload / duration;
  if (duration >= backgroundDownload.minDuration
    && downloadRate >= backgroundDownload.minDownloadRate
    && uploadRate <= backgroundDownload.maxUploadRate) {
    return true;
  }
  return false;
}

// Filter flows that match internet activity criteria
function lookupAppMatch(flows, internet_time_usage_config, noiseDomainsSensor) {
  if (!flows || !Array.isArray(flows)) {
    return [];
  }

  if (!internet_time_usage_config) {
    return flows; // If no config, return all flows
  }

  const matchedFlows = [];
  const nds = noiseDomainsSensor;

  for (const flow of flows) {
    // Get flow properties
    // Note: flow.rb is download, flow.ob is upload in the original format
    // But in the comment format, it's flow.upload and flow.download
    const upload = flow.upload || flow.ob || 0;
    const download = flow.download || flow.rb || 0;
    const count = flow.count || 1;
    const host = flow.host || (flow.intel && flow.intel.host);
    const category = _.get(flow, ["intel", "category"]);

    // Get thresholds from config
    const bytesThreshold = getCategoryBytesThreshold(category, internet_time_usage_config);
    const ulDlRatioThreshold = getCategoryUlDlRatioThreshold(category, internet_time_usage_config);
    const backgroundDownload = getCategoryBackgroundDownload(category, internet_time_usage_config);

    // Check noise tags
    let flowNoiseTags = null;
    if (nds && host) {
      flowNoiseTags = nds.find(host);
    }

    // Check if flow matches internet activity criteria
    // flow.ob + flow.rb >= bytesThreshold && flow.ob <= ulDlRatioThreshold * flow.rb && _.isEmpty(flowNoiseTags) && !isBackgroundDownload(flow, backgroundDownload)

    if (upload + download >= bytesThreshold * count
      && upload <= ulDlRatioThreshold * download 
      && _.isEmpty(flowNoiseTags) 
      && !isBackgroundDownload(flow, backgroundDownload)) {
      matchedFlows.push(flow);
      log.debug("match internet activity on flow", flow, `bytesThreshold: ${bytesThreshold}`);
    }
    // matchedFlows.push(flow);
   
  }

  return matchedFlows;
}


// Main function
async function main() {
  try {
    // Get timezone from Redis first (needed for parsing date strings)
    const timezone = await rclient.hgetAsync("sys:config", "timezone");
    
    // Parse and validate arguments
    const options = parseArgs();
    const { startTs, endTs } = validateArgs(options, timezone);
    const { mac, appName } = options;

    // Build flow query options
    // Note: begin is start time, end is end time
    const baseOptions = {
      begin: startTs,
      end: endTs,
      count: 500,  // Batch size: fetch 500 flows per request
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
    
    // Get flows by calling prepareRecentFlows multiple times until all data is retrieved
    // Fetch 500 flows per batch until all flows in the specified time range are retrieved
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
        
        // Check if we've reached or exceeded the end time
        if (lastTs >= endTs) {
          completed = true;
          break;
        }

        // If we got fewer flows than requested (500), we've reached the end
        if (flows.length < currentOptions.count) {
          completed = true;
        } else {
          // Update begin time to continue from where we left off
          currentOptions.ts = lastTs;
        }
        // log.debug(`Loaded ${flows.length} flows, total: ${allFlows.length}, lastTs: ${lastTs}`);
      } catch (e) {
        log.error(`Load flows error`, e);
        completed = true;
      }
    }
    
    const flows = allFlows;

    // Get internet time usage config from Redis and parse to JSON object
    const configStr = await rclient.getAsync('internet_time_usage_config');
    const internet_time_usage_config = configStr ? JSON.parse(configStr) : null;

    // Initialize NoiseDomainsSensor
    const noiseDomainsSensor = new NoiseDomainsSensor();
    await noiseDomainsSensor.apiRun();

    // Filter flows that match internet activity criteria
    const matchedFlows = lookupAppMatch(flows, internet_time_usage_config, noiseDomainsSensor);

    // Print matched flows in table format
    console.log('\n=== Matched Flows ===');
    console.log(`Total matched flows: ${matchedFlows.length}\n`);
    
    if (matchedFlows.length > 0) {
      // Define column widths
      const colWidths = {
        ts: 19,           // YYYY-MM-DD HH:mm:ss
        count: 6,         // numeric
        duration: 10,     // numeric
        protocol: 8,      // tcp/udp/etc
        port: 6,          // 0-65535
        devicePort: 12,    // 0-65535
        ip: 16,           // IPv4 max length
        deviceIP: 16,     // IPv4 max length
        upload: 12,       // "123.45 KB"
        download: 12,     // "123.45 KB"
        total_average: 13, // "123.45 KB"
        device: 17,       // MAC address
        host: 30          // domain name
      };
      
      // Print header
      const header = [
        'ts'.padEnd(colWidths.ts),
        'count'.padEnd(colWidths.count),
        'duration'.padEnd(colWidths.duration),
        'protocol'.padEnd(colWidths.protocol),
        'port'.padEnd(colWidths.port),
        'devicePort'.padEnd(colWidths.devicePort),
        'ip'.padEnd(colWidths.ip),
        'deviceIP'.padEnd(colWidths.deviceIP),
        'upload'.padEnd(colWidths.upload),
        'download'.padEnd(colWidths.download),
        'total_average'.padEnd(colWidths.total_average),
        'device'.padEnd(colWidths.device),
        'host'.padEnd(colWidths.host)
      ].join(' | ');
      
      console.log(header);
      console.log('-'.repeat(header.length));
      
      // Print rows
      for (const flow of matchedFlows) {
        const ts = flow.ts || flow._ts || 0;
        // Format time with timezone
        const readableTime = timezone 
          ? moment.unix(ts).tz(timezone).format('YYYY-MM-DD HH:mm:ss')
          : moment.unix(ts).format('YYYY-MM-DD HH:mm:ss');
        const tsStr = `${readableTime}`.substring(0, colWidths.ts);
        
        const upload = flow.upload || flow.ob || 0;
        const download = flow.download || flow.rb || 0;
        const count = flow.count || 1;
        const total_average = count > 0 ? Math.round((upload + download) / count) : 0;
        
        // Convert bytes to KB
        const uploadKB = (upload / 1024).toFixed(2);
        const downloadKB = (download / 1024).toFixed(2);
        const total_averageKB = (total_average / 1024).toFixed(2);
        
        const row = [
          tsStr.padEnd(colWidths.ts),
          String(count).padEnd(colWidths.count),
          String(flow.duration || flow.du || 0).padEnd(colWidths.duration),
          String(flow.protocol || flow.pr || '').padEnd(colWidths.protocol),
          String(flow.port || flow.dp || '').padEnd(colWidths.port),
          String(flow.devicePort || (Array.isArray(flow.sp) ? flow.sp[0] : flow.sp) || '').padEnd(colWidths.devicePort),
          String(flow.ip || flow.dh || '').padEnd(colWidths.ip),
          String(flow.deviceIP || flow.sh || '').padEnd(colWidths.deviceIP),
          `${uploadKB} KB`.padEnd(colWidths.upload),
          `${downloadKB} KB`.padEnd(colWidths.download),
          `${total_averageKB} KB`.padEnd(colWidths.total_average),
          String(flow.device || flow.mac || '').padEnd(colWidths.device),
          String(flow.host || (flow.intel && flow.intel.host) || '').substring(0, colWidths.host).padEnd(colWidths.host)
        ].join(' | ');
        
        console.log(row);
      }
      console.log('');
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

// Run main function
main();
