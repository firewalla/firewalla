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
    this.scheduledJobs = {};
    this.savedDevices = {};
  }

  /*
  Default config in config.json might have following supported PLACEHOLDERS
  ---------------------------------------------------------------------------
    "NetworkMonitorSensor": {
      "stat": {
        "calculateInterval":  300
      },
      "cleanup": {
        "expirePeriod": 86400
      },
      "targets": {
        "MY_GATEWAYS": {
          "ping": {
              "sampleCount": 20,
              "sampleInterval": 30
          }
        },
        ...
      }
    }
  ----------------------------------------------------------------------------
   */
  loadDefaultConfig() {
    let defaultConfig = {};
    if (this.config) {
      try {
        const cfg = this.config.targets
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
        log.info("this.config: ", JSON.stringify(this.config,null,4));
        log.info("defaultConfig: ", JSON.stringify(defaultConfig,null,4));
      } catch(err) {
        log.error("Failed to load default network monitor config: ", err);
      }
    }
    return defaultConfig;
  }

  async run() {
    
    /*
     * global feature switch(on/off) with static configuration(config.json)
     */

    log.info("run NetworkMonitorSensor ...");
    if (fc.isFeatureOn(FEATURE_NETWORK_MONITOR)) {
      await this.turnOn();
    } else {
      await this.turnOff();
    }

    fc.onFeature(FEATURE_NETWORK_MONITOR, (feature, status) => {
      if (feature != FEATURE_NETWORK_MONITOR) return;
      if (status) {
        this.turnOn();
      } else {
        this.turnOff();
      }
    })

    /*
     * feature switches in policy
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
    //log.info(`sample PING to ${target} with cfg(${JSON.stringify(cfg,null,4)})`);
    try {
      const timeNow = Date.now();
      const timeSlot = (timeNow - timeNow % (cfg.sampleInterval*1000))/1000;
      const result = await exec(`ping -c ${cfg.sampleCount} -4 -n -w 3 ${target}| awk '/time=/ {print $7}' | cut -d= -f2`)
      const data = result.stdout.trim().split(/\n/);
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
        data.push(result.stdout.trim());
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
        data.push(result.stdout.trim());
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
      if ( scheduledKey in this.scheduledJobs ) {
        log.warn(`${monitorType} on ${key} already started`);
      } else {
        log.info(`scheduling ${monitorType} on ${key} ...`);
        this.scheduledJobs[scheduledKey] = this.scheduleSampleJob(monitorType,ip,cfg[monitorType]);
      }
    }
  }

  stopMonitorDevice(key) {
    log.info(`stop monitoring ${key} ...`)
    for ( const monitorType of MONITOR_TYPES ) {
      const scheduledKey = `${key}-${monitorType}`;
      if ( scheduledKey in this.scheduledJobs ) {
        log.info(`UNscheduling ${monitorType} on ${key} ...`);
        clearInterval(this.scheduledJobs[scheduledKey]);
        delete(this.scheduledJobs[scheduledKey])
      } else {
        log.warn(`${monitorType} on ${key} NOT scheduled`);
      }
    }
  }

  stopMonitorDeviceAll() {
    Object.keys(this.scheduledJobs).forEach( scheduledKey => {
      log.info(`UNscheduling ${scheudledKey} ...`);
      clearInterval(this.scheduledJobs[scheduledKey]);
      delete(this.scheduledJobs[scheduledKey]);
    })
    log.info("after stop all: ", JSON.stringify(this.scheduledJobs,null,4));
  }

  async applyPolicyDevice(host, state, cfg) {
    try {
      log.info(`Apply policy on device ${host} with state(${state}) and config(${cfg}) ...`);
      const key = host.o.mac;
      switch ( state ) {
        case true: {
          this.startMonitorDevice(key, host.o.ip, cfg);
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

  async turnOn() {
    try {
      log.info("Feature is turned on.");
      // system level : load from policy or start by default policy
      const policyConfigJSON = await rclient.hgetAsync('policy:system', POLICY_KEYNAME )
      const policyConfig = policyConfigJSON ? JSON.parse(policyConfigJSON) : { "state":true, "config": null};
      log.info("policyConfig:",policyConfig);
      this.applyPolicySystem(policyConfig.state,policyConfig.config);
      // device level
      for (const mac in Object.keys(this.savedDevices)) {
        const policyDevice = await rclient.hgetAsync('policy:mac', mac);
        await this.applyPolicyDevice(this.savedDevices[mac], policyDevice.state, policyDevice.config);
      }
    } catch (err) {
      log.error(`failed to turn on feature ${FEATURE_NETWORK_MONITOR}: `,err)
    }
  }

  async turnOff() {
    this.stopMonitorDeviceAll();
    log.info("Feature is turned off.");
  }

  async getNetworkMonitorData() {
    try {
      for (const monitorType of MONITOR_TYPES) {
        const redisKey = `${KEY_PREFIX_RAW}:${monitorType}`
        const config_json = await rclient.hgetAsync(redisKey);
        result[$monitorType] = JSON.parse(config_json);
      }
      return result;
    } catch (err) {
      log.error("failed to get network monitor config: ",err);
      return {};
    }
  }

  async apiRun() {
    extensionManager.onGet("networkMonitorData", async (msg, data) => {
      return this.getNetworkMonitorData();
    });
  }

  async recordSampleDataInRedis(monitorType, target, timeSlot, data) {
    const redisKey = `${KEY_PREFIX_RAW}:${monitorType}:${target}`;
    log.info(`record sample data in ${redisKey} at ${timeSlot}`);
    try {
      const dataSorted = [...data].sort( (a,b) => {
        return a-b
      })
      const dataLength = dataSorted.length;
      const median = (dataLength%2 === 0) ? (dataSorted[dataLength/2-1]+dataSorted[dataLength/2])/2 : dataSorted[(dataLength-1)/2];
      const result = {
        "data": data,
        "stat" : {
          "median": median,
          "min"   : dataSorted[0],
          "max"   : dataSorted[dataLength-1]
        }
      }
      const resultJSON = JSON.stringify(result);
      await rclient.hsetAsync(redisKey, timeSlot, resultJSON);
    } catch (err) {
      log.error("failed to record sample data of ${moitorType} for ${target} :", err);
    }
  }

}

module.exports = NetworkMonitorSensor;
