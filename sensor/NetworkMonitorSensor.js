/*    Copyright 2016-2020 Firewalla INC
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

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const exec = require('child-process-promise').exec;
const f = require('../net2/Firewalla.js');
const fc = require('../net2/config.js');
const extensionManager = require('./ExtensionManager.js')
const rclient = require('../util/redis_manager.js').getRedisClient();
const sysManager = require('../net2/SysManager.js');
const sem = require('./SensorEventManager.js').getInstance();

const KEY_PREFIX = `metric:monitor`;
const KEY_PREFIX_RAW = `${KEY_PREFIX}:raw`;
const KEY_PREFIX_STAT = `${KEY_PREFIX}:stat`;
const FEATURE_NETWORK_MONITOR = "network_monitor";
const POLICY_KEYNAME = 'network_monitor';
const MONITOR_PING = "ping";
const MONITOR_DNS = "dns";
const MONITOR_HTTP = "http";
const MONITOR_TYPES = [ MONITOR_PING, MONITOR_DNS, MONITOR_HTTP];


class NetworkMonitorSensor extends Sensor {

  constructor() {
    super()
    this.adminSwitch = false;
    this.sampleJobs = {};
    this.processJobs = {};
    this.cachedPolicy = { "system": {}, "devices": {} };
  }

  /*
  Default config in config.json might have following supported PLACEHOLDERS
  ---------------------------------------------------------------------------
    "NetworkMonitorSensor": {
        "MY_GATEWAYS": {
          "ping": {
              "sampleCount": 20,
              "sampleInterval": 30
          }
        },
        ...
    }
  ----------------------------------------------------------------------------
   */
  loadDefaultConfig() {
    let defaultConfig = {};
    if (this.config) {
      try {
        const cfg = this.config
        log.info("Loading default network monitor config ...");
        Object.keys(cfg).forEach ( key => {
          switch (key) {
            case "MY_GATEWAYS":
              for (const gw  of sysManager.myGatways() ) {
                defaultConfig[gw] = {...defaultConfig[gw], ...cfg[key]};
              }
              break;
            case "MY_DNSES":
              for (const dns of sysManager.myDnses() ) {
                defaultConfig[dns] = {...defaultConfig[dns], ...cfg[key]};
              }
              break;
            default:
              defaultConfig[key] = {...defaultConfig[key], ...cfg[key]};
              break;
          }
        });
        log.debug("this.config: ", JSON.stringify(this.config,null,4));
        log.debug("defaultConfig: ", JSON.stringify(defaultConfig,null,4));
      } catch(err) {
        log.error("Failed to load default network monitor config: ", err);
      }
    }
    return defaultConfig;
  }

  async applyCachedPolicy() {
    log.info("Apply cached policy ... ");
    log.debug("cachedPolicy: ", this.cachedPolicy);
    try {
      const systemPolicy = this.cachedPolicy.system;
      if ( systemPolicy ) {
        this.applyPolicySystem(systemPolicy.state,systemPolicy.config);
      }
      for (const mac in this.cachedPolicy.devices) {
        const deviceConfig = this.cachedPolicy.devices[mac]
        this.applyPolicyDevice(deviceConfig.host, deviceConfig.policy.state, deviceConfig.policy.config);
      }
    } catch (err) {
      log.error( "failed to apply cached policy: ", err);
    }
  }

  async globalOn() {
    log.info("run globalOn ...");
    this.adminSwitch = true;
    this.applyCachedPolicy();
  }

  async globalOff() {
    log.info("run globalOff ...");
    this.adminSwitch = false;
    this.applyCachedPolicy();
  }

  async run() {
    
    log.info("run NetworkMonitorSensor ...");

    this.hookFeature(FEATURE_NETWORK_MONITOR);

    /*
     * apply policy upon policy change or startup
     */
    extensionManager.registerExtension(POLICY_KEYNAME, this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop
    });

  }

  applyPolicySystem(systemState,systemConfig) {
    log.info(`Apply monitoring policy change with systemState(${systemState}) and systemConfig(${systemConfig})`);

    try {
      const runtimeConfig = systemConfig || this.loadDefaultConfig();
      log.debug("runtimeConfig: ",runtimeConfig);
      Object.keys(runtimeConfig).forEach( async targetIP => {
        // always restart to run with latest config
        this.stopMonitorDevice(targetIP);
        if ( systemState && this.adminSwitch ) {
            this.startMonitorDevice(targetIP, targetIP, runtimeConfig[targetIP]);
        } else {
            this.stopMonitorDevice(targetIP);
        }
      });
    } catch (err) {
      log.error("failed to apply monitoring policy change: ", err);
    }
    return;
  }

  async samplePing(target, cfg) {
    log.debug(`sample PING to ${target}`);
    log.debug("config: ", cfg);
    try {
      const timeNow = Date.now();
      const timeSlot = (timeNow - timeNow % (cfg.sampleInterval*1000))/1000;
      const result = await exec(`ping -c ${cfg.sampleCount} -4 -n ${target}| awk '/time=/ {print $7}' | cut -d= -f2`)
      const data = result.stdout.trim().split(/\n/).map(e => parseFloat(e));
      this.recordSampleDataInRedis(MONITOR_PING, target, timeSlot, data);
    } catch (err) {
      log.error("failed to sample PING:",err);
    }
  }

  async sampleDNS(target, cfg) {
    log.debug(`sample DNS to ${target}`);
    log.debug("config: ", cfg);
    try {
      const timeNow = Date.now();
      const timeSlot = (timeNow - timeNow % (cfg.sampleInterval*1000))/1000;
      let data = [];
      for (let i=0;i<cfg.sampleCount;i++) {
        const result = await exec(`dig @${target} ${cfg.lookupName} | awk '/Query time:/ {print $4}'`);
        data.push(parseInt(result.stdout.trim()));
      }
      //this.recordSampleDataInRedis(MONITOR_DNS, `${target}:${cfg.lookupName}`, timeSlot, data);
      this.recordSampleDataInRedis(MONITOR_DNS, target, timeSlot, data);
    } catch (err) {
      log.error("failed to sample DNS:",err);
    }
  }

  async sampleHTTP(target, cfg) {
    log.debug(`sample HTTP to ${target}`);
    log.debug("config: ", cfg);
    try {
      const timeNow = Date.now();
      const timeSlot = (timeNow - timeNow % (cfg.sampleInterval*1000))/1000;
      let data = [];
      for (let i=0;i<cfg.sampleCount;i++) {
        const result = await exec(`curl -m 10 -w '%{time_total}\n' '${target}'`);
        data.push(parseFloat(result.stdout.trim()));
      }
      this.recordSampleDataInRedis(MONITOR_HTTP, target, timeSlot, data);
    } catch (err) {
      log.error("failed to sample HTTP:",err);
    }
  }

  scheduleSampleJob(monitorType, ip ,cfg) {
    log.info(`schedule a sample job ${monitorType} with ip(${ip})`);
    log.debug("config:",cfg);
    let scheduledJob = null;
    switch (monitorType) {
      case MONITOR_PING: {
        scheduledJob = setInterval(() => {
          this.samplePing(ip,cfg);
        }, 1000*cfg.sampleInterval);
        break;
      }
      case MONITOR_DNS: {
        scheduledJob = setInterval(() => {
          this.sampleDNS(ip,cfg);
        }, 1000*cfg.sampleInterval);
        break;
      }
      case MONITOR_HTTP: {
        scheduledJob = setInterval(() => {
          this.sampleHTTP(ip,cfg);
        }, 1000*cfg.sampleInterval);
        break;
      }
    }
    return scheduledJob;
  }

  startMonitorDevice(key,ip,cfg) {
    log.info(`start monitoring ${key} with ip(${ip})`);
    log.debug("config: ", cfg);
    for ( const monitorType of Object.keys(cfg) ) {
      const scheduledKey = `${key}-${monitorType}`;
      if ( scheduledKey in this.sampleJobs ) {
        log.warn(`${monitorType} on ${key} already started`);
      } else {
        log.debug(`scheduling sample job ${monitorType} on ${key} ...`);
        this.sampleJobs[scheduledKey] = this.scheduleSampleJob(monitorType,ip,cfg[monitorType]);
        log.debug(`scheduling process job ${monitorType} on ${key} ...`);
        this.processJobs[scheduledKey] = this.scheduleProcessJob(monitorType,ip,cfg[monitorType]);
      }
    }
  }

  stopMonitorDevice(key) {
    log.info(`stop monitoring ${key} ...`)
    for ( const monitorType of MONITOR_TYPES ) {
      const scheduledKey = `${key}-${monitorType}`;
      if ( scheduledKey in this.sampleJobs ) {
        log.debug(`UNscheduling sample ${monitorType} on ${key} ...`);
        clearInterval(this.sampleJobs[scheduledKey]);
        delete(this.sampleJobs[scheduledKey])
      } else {
        log.debug(`${monitorType} on ${key} NOT scheduled`);
      }
      if ( scheduledKey in this.processJobs ) {
        log.debug(`UNscheduling process ${monitorType} on ${key} ...`);
        clearInterval(this.processJobs[scheduledKey]);
        delete(this.processJobs[scheduledKey])
      } else {
        log.debug(`${monitorType} on ${key} NOT scheduled`);
      }
    }
  }

  stopMonitorDeviceAll() {
    Object.keys(this.sampleJobs).forEach( scheduledKey => {
      log.debug(`UNscheduling ${scheduledKey} in sample jobs ...`);
      clearInterval(this.sampleJobs[scheduledKey]);
      delete(this.sampleJobs[scheduledKey]);
    })
    Object.keys(this.processJobs).forEach( scheduledKey => {
      log.debug(`UNscheduling ${scheduledKey} in stat jobs ...`);
      clearInterval(this.processJobs[scheduledKey]);
      delete(this.processJobs[scheduledKey]);
    })
  }

  applyPolicyDevice(host, state, cfg) {
    try {
      log.info(`Apply policy on device ${host.o.mac}/${host.o.ipv4Addr} with state(${state}) and config(${cfg}) ...`);
      const key = host.o.mac;
      if ( state && this.adminSwitch ) {
          // always restart to run with latest config
          this.stopMonitorDevice(key);
          this.startMonitorDevice(key, host.o.ipv4Addr, cfg);
      } else {
          this.stopMonitorDevice(key);
      }
    } catch (err) {
      log.error(`failed to apply policy on device ${host.o.mac}/${host.o.ipv4Addr}: `,err);
    }
  }

  applyPolicy(host, ip, policy) {
    log.info(`Apply network monitor policy with host(${host && host.o && host.o.mac}), ip(${ip})`);
    log.debug("policy: ",policy);
    try {
        if (ip === '0.0.0.0') {
            this.cachedPolicy.system = policy;
            this.applyPolicySystem(policy.state,policy.config);
        } else {
            if (!host) return;
            if (host.constructor.name === "Host" && policy) {
              this.cachedPolicy.devices[host.o.mac] = {"host":host, "policy": policy};
              this.applyPolicyDevice(host, policy.state, policy.config);
            }
            
        }
    } catch (err) {
        log.error("Got error when applying policy", err);
    }
  }

  async getNetworkMonitorData() {
    log.info("Trying to get network monitor data...")
    try {
      let result = {};
      await rclient.scanAll(`${KEY_PREFIX_RAW}:*`, async (scanResults) => {
        for ( const key of scanResults) {
          result[key] = await rclient.hgetallAsync(key);
        }
      },10000);
      return result;
    } catch (err) {
      log.error("failed to get network monitor config: ",err);
      return {};
    }
  }

  async apiRun(){
    extensionManager.onGet("networkMonitorData", async (msg) => {
      return this.getNetworkMonitorData();
    });
  }

  async recordSampleDataInRedis(monitorType, target, timeSlot, data) {
    const redisKey = `${KEY_PREFIX_RAW}:${monitorType}:${target}`;
    log.debug(`record sample data(${JSON.stringify(data,null,4)}) in ${redisKey} at ${timeSlot}`);
    try {
      const dataSorted = [...data].sort( (a,b) => {
        return a-b
      })
      const l = dataSorted.length;
      if (l>0) {
        const result = {
          "data": data,
          "stat" : {
            "median": parseFloat(((l%2 === 0) ? (dataSorted[l/2-1]+dataSorted[l/2])/2 : dataSorted[(l-1)/2]).toFixed(1)),
            "min"   : parseFloat(dataSorted[0].toFixed(1)),
            "max"   : parseFloat(dataSorted[l-1].toFixed(1))
          }
        }
        const resultJSON = JSON.stringify(result);
        await rclient.hsetAsync(redisKey, timeSlot, resultJSON);
      }
    } catch (err) {
      log.error("failed to record sample data of ${moitorType} for ${target} :", err);
    }
  }

  async processJob(monitorType,target,cfg) {
    log.info(`start process ${monitorType} data for ${target}`);
    log.debug("config: ", cfg);
    try {
      const expireTS = Math.floor(Date.now()/1000) - cfg.expirePeriod;
      const scanKey = `${KEY_PREFIX_RAW}:${monitorType}:${target}`;
      let allData = [];
      let scanCursor = 0;
      log.debug("expireTS=",expireTS);
      log.debug("scanKey=",scanKey);
      while ( true ) {
        const scanResult = await rclient.hscanAsync(scanKey,scanCursor);
        log.debug("scanResult:",scanResult);
        if ( !scanResult ) {
          log.error(`hscan on key(${scanKey}) failed at cursor(${scanCursor}) with invalid result`);
          break;
        }
        for ( let i=0; i<scanResult[1].length; i+=2) {
          const ts = scanResult[1][i];
          if ( ts < expireTS ) { // clean expired data
            log.debug(`deleting expired(${ts}>${expireTS}) data`);
            await rclient.hdelAsync(scanKey, ts);
          } else { // collect effective data to calculate stats
            const result_json = scanResult[1][i+1];
            log.debug(`scanKey=${scanKey}, ts=${ts}, result_json=${result_json}`);
            const result = JSON.parse(result_json);
            if (result && result.stat && result.stat.median) {
              log.debug(`collect data of ${scanKey} at ${ts}`);
              allData.push(parseFloat(result.stat.median)); // choose median as sample data for overall stats
              log.debug("allData.length:",allData.length);
            }
          }
        }
        scanCursor = parseInt(scanResult[0]);
        if ( scanCursor === 0 ) break; // scan finishes when cursor back to 0
      }

      // calcualte and record stats
      allData.sort((a,b) => a-b );
      log.debug("sorted allData:",allData);
      const l = allData.length;
      if (l > 0) {
        const statKey = `${KEY_PREFIX_STAT}:${monitorType}:${target}`;
        log.debug("record stat data at ",statKey);
        await rclient.hsetAsync(statKey, "min", parseFloat(allData[0].toFixed(1)));
        await rclient.hsetAsync(statKey, "max", parseFloat(allData[l-1].toFixed(1)));
        await rclient.hsetAsync(statKey, "median", parseFloat(((l%2 === 0) ? (allData[l/2-1]+allData[l/2])/2 : allData[(l-1)/2]).toFixed(1)));
      }
    } catch (err) {
      log.error(`failed to process data of ${monitorType} for target(${target}): `,err);
    }
  }

  scheduleProcessJob(monitorType,ip,cfg) {
    log.info(`scheduling process job for ${monitorType} with ip(${ip})`);
    log.debug("config: ",cfg);
    const scheduledJob = setInterval(() => {
      this.processJob(monitorType,ip,cfg);
    }, 1000*cfg.processInterval);
    return scheduledJob;
  }

}

module.exports = NetworkMonitorSensor;
