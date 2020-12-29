/*    Copyright 2016-2020 Firewalla LLC
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
    this.sampleJobs = {};
    this.statJobs = {};
    this.savedDevices = {};
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

  async run() {
    
    log.info("run NetworkMonitorSensor ...");

    /*
     * apply policy upon policy change or startup
     */
    extensionManager.registerExtension(POLICY_KEYNAME, this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop
    });

  }

  async applyPolicySystem(systemState,systemConfig) {
    log.info(`Apply monitoring policy change with systemState(${systemState}) and systemConfig(${systemConfig})`);

    try {
      switch ( systemState ) {
        case true: {
          const runtimeConfig = systemConfig || this.loadDefaultConfig();
          log.info("runtimeConfig: ",runtimeConfig);
          Object.keys(runtimeConfig).forEach( async targetIP => {
            // always restart to run with latest config
            this.stopMonitorDevice(targetIP);
            await this.startMonitorDevice(targetIP, targetIP, runtimeConfig[targetIP]);
          });
          break;
        }
        case false: {
          this.stopMonitorDeviceAll();
          break;
        }
        default: {
          log.error("unsupported state: ",systemState);
        }
      }
    } catch (err) {
      log.error("failed to apply monitoring policy change: ", err);
    }
    return;
  }

  async samplePing(target, cfg) {
    log.info(`sample PING to ${target} with cfg(${JSON.stringify(cfg,null,4)})`);
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
    //log.info(`sample DNS to ${target} with cfg(${JSON.stringify(cfg,null,4)})`);
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
    //log.info(`sample HTTP to ${target} with cfg(${JSON.stringify(cfg,null,4)})`);
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

  async scheduleSampleJob(monitorType, ip ,cfg) {
    //log.info(`schedule a sample job ${monitorType} with ip(${ip}) and config(${JSON.stringify(cfg,null,4)})`);
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

  async startMonitorDevice(key,ip,cfg) {
    if ( ! fc.isFeatureOn(FEATURE_NETWORK_MONITOR) ) {
      log.warn(`start monitor device ${key} with ${ip} ABORT due to feature OFF`);
      return;
    }
    log.info(`start monitoring ${key} with ip(${ip}) and cfg(${JSON.stringify(cfg,null,4)}) ...`)
    for ( const monitorType of Object.keys(cfg) ) {
      const scheduledKey = `${key}-${monitorType}`;
      if ( scheduledKey in this.sampleJobs ) {
        log.warn(`${monitorType} on ${key} already started`);
      } else {
        log.debug(`scheduling sample job ${monitorType} on ${key} ...`);
        this.sampleJobs[scheduledKey] = this.scheduleSampleJob(monitorType,ip,cfg[monitorType]);
        log.debug(`scheduling stat job ${monitorType} on ${key} ...`);
        this.statJobs[scheduledKey] = this.scheduleStatJob(monitorType,ip,cfg[monitorType]);
      }
    }
  }

  stopMonitorDevice(key) {
    log.info(`stop monitoring ${key} ...`)
    for ( const monitorType of MONITOR_TYPES ) {
      const scheduledKey = `${key}-${monitorType}`;
      if ( scheduledKey in this.sampleJobs ) {
        log.debug(`UNscheduling ${monitorType} on ${key} ...`);
        clearInterval(this.sampleJobs[scheduledKey]);
        delete(this.sampleJobs[scheduledKey])
      } else {
        log.warn(`${monitorType} on ${key} NOT scheduled`);
      }
      if ( scheduledKey in this.statJobs ) {
        log.debug(`UNscheduling ${monitorType} on ${key} ...`);
        clearInterval(this.statJobs[scheduledKey]);
        delete(this.statJobs[scheduledKey])
      } else {
        log.warn(`${monitorType} on ${key} NOT scheduled`);
      }
    }
  }

  stopMonitorDeviceAll() {
    Object.keys(this.sampleJobs).forEach( scheduledKey => {
      log.debug(`UNscheduling ${scheudledKey} in sample jobs ...`);
      clearInterval(this.sampleJobs[scheduledKey]);
      delete(this.sampleJobs[scheduledKey]);
    })
    Object.keys(this.statJobs).forEach( scheduledKey => {
      log.debug(`UNscheduling ${scheudledKey} in stat jobs ...`);
      clearInterval(this.statJobs[scheduledKey]);
      delete(this.statJobs[scheduledKey]);
    })
    log.info("after stop all: ", JSON.stringify(this.sampleJobs,null,4));
  }

  async applyPolicyDevice(host, state, cfg) {
    try {
      log.info(`Apply policy on device ${host} with state(${state}) and config(${cfg}) ...`);
      const key = host.o.mac;
      switch ( state ) {
        case true: {
          // always restart to run with latest config
          this.stopMonitorDevice(key);
          this.startMonitorDevice(key, host.o.ipv4Addr, cfg);
          break;
        }
        case false: {
          this.stopMonitorDevice(key);
          break;
        }
        default: {
          log.error("unsupported state: ",state);
        }
      }
    } catch (err) {
      log.error(`failed to apply policy on device ${host}: `,err);
    }
    return;
  }

  async applyPolicy(host, ip, policy) {
    log.info(`Apply network monitor policy with host(${host}), ip(${ip}), policy(${policy})`);
    try {
        if (ip === '0.0.0.0') {
            if (policy.state === true) {
                if (fc.isFeatureOn(FEATURE_NETWORK_MONITOR, false)) {//compatibility: new firewlla, old app
                    await fc.enableDynamicFeature(FEATURE_NETWORK_MONITOR);
                }
            }
            return this.applyPolicySystem(policy.state,policy.config);
        } else {
            if (!host) return;
            if (host.constructor.name === "Host" && policy) {
              this.savedDevices[host.o.mac] = host;
              await this.applyPolicyDevice(host, policy.state, policy.config);
            }
            
        }
    } catch (err) {
        log.error("Got error when applying policy", err);
    }
  }

  async getNetworkMonitorData() {
    try {
      for (const monitorType of MONITOR_TYPES) {
        const redisKey = `${KEY_PREFIX_RAW}:${monitorType}`
        const config_json = rclient.hgetall(redisKey);
        result[$monitorType] = JSON.parse(config_json);
      }
      return result;
    } catch (err) {
      log.error("failed to get network monitor config: ",err);
      return {};
    }
  }

  async apiRun(){
    extensionManager.onGet("networkMonitorData", async (msg, data) => {
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
            "median": (l%2 === 0) ? (dataSorted[l/2-1]+dataSorted[l/2])/2 : dataSorted[(l-1)/2],
            "min"   : dataSorted[0],
            "max"   : dataSorted[l-1]
          }
        }
        const resultJSON = JSON.stringify(result);
        await rclient.hsetAsync(redisKey, timeSlot, resultJSON);
      }
    } catch (err) {
      log.error("failed to record sample data of ${moitorType} for ${target} :", err);
    }
  }

  async statCalulate(monitorType,target,cfg) {
    log.info(`calculate stat of ${monitorType} for ${target} with cfg(${JSON.stringify(cfg,null,4)})`);
    try {
      // calculate between [timeSinceSlot , timeTillSlot]
      const timeTill = Date.now()-cfg.sampleInterval*1000; // caculate with one sampleInterval delay
      const timeTillSlot = (timeTill - timeTill % (cfg.sampleInterval*1000))/1000;
      const timeSince = timeTill - 1000*cfg.expirePeriod;
      const timeSinceSlot = (timeSince - timeSince%(cfg.sampleInterval*1000))/1000;

      const rawKey = `${KEY_PREFIX_RAW}:${monitorType}:${target}`;
      log.debug("timeSinceSlot=",timeSinceSlot);
      log.debug("timeTillSlot=",timeTillSlot);
      let allData = [];
      for (let ts=timeTillSlot; ts>=timeSinceSlot; ts-=cfg.sampleInterval) {
        const result_json = await rclient.hgetAsync(rawKey,ts);
        if (result_json) {
          log.debug(`rawKey=${rawKey}, ts=${ts}, result_json=${result_json}`);
          const result = JSON.parse(result_json);
          if (result && result.stat && result.stat.median) {
            log.debug(`collect data into ${ts} at ${rawKey}`);
            allData.push(result.stat.median);
            log.debug("allData.length:",allData.length);
          }
        } else {
          log.warn(`Data ${rawKey} misssing`);
          break;
        }
      }
      allData.sort((a,b) => a-b );
      log.debug("sorted allData:",allData);
      const l = allData.length;
      if (l > 0) {
        const statKey = `${KEY_PREFIX_STAT}:${monitorType}:${target}`;
        log.info("record stat data at ",statKey);
        await rclient.hsetAsync(statKey, "min", allData[0]);
        await rclient.hsetAsync(statKey, "max", allData[l-1]);
        await rclient.hsetAsync(statKey, "median", (l%2 === 0) ? (allData[l/2-1]+allData[l/2])/2 : allData[(l-1)/2]);
      }

    } catch (err) {
      log.error("failed to calculate stats: ", err);
    }
  }

  async scheduleStatJob(monitorType,ip,cfg) {
    log.info(`scheduling stat job for ${monitorType} with ip(${ip}) and cfg(${JSON.stringify(cfg,null,4)})`);
    const scheduledJob = setInterval(() => {
      this.statCalulate(monitorType,ip,cfg);
    }, 1000*cfg.statInterval);
    return scheduledJob;
  }
}

module.exports = NetworkMonitorSensor;
