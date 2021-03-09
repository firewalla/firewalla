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

const era = require('../event/EventRequestApi.js');
const Alarm = require('../alarm/Alarm.js');
const AlarmManager2 = require('../alarm/AlarmManager2.js');
const alarmManager2 = new AlarmManager2();

const KEY_PREFIX = `metric:monitor`;
const KEY_PREFIX_RAW = `${KEY_PREFIX}:raw`;
const KEY_PREFIX_STAT = `${KEY_PREFIX}:stat`;
const FEATURE_NETWORK_MONITOR = "network_monitor";
const POLICY_KEYNAME = 'network_monitor';
const MONITOR_PING = "ping";
const MONITOR_DNS = "dns";
const MONITOR_HTTP = "http";
const MONITOR_TYPES = [ MONITOR_PING, MONITOR_DNS, MONITOR_HTTP];
const DEFAULT_SYSTEM_POLICY_STATE = true;


class NetworkMonitorSensor extends Sensor {

  constructor() {
    super()
    this.adminSwitch = false;
    this.sampleJobs = {};
    this.processJobs = {};
    this.cachedPolicy = { "system": {}, "devices": {} };
    this.alerts = {};
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
  loadRuntimeConfig(cfg) {
    let runtimeConfig = {};
    if (cfg) {
      try {
        log.info("Loading runtime network monitor config ...");
        Object.keys(cfg).forEach ( key => {
          switch (key) {
            case "MY_GATEWAYS":
              for (const gw  of sysManager.myGateways() ) {
                runtimeConfig[gw] = {...runtimeConfig[gw], ...cfg[key]};
              }
              break;
            case "MY_DNSES":
              for (const dns of sysManager.myDnses() ) {
                runtimeConfig[dns] = {...runtimeConfig[dns], ...cfg[key]};
              }
              break;
            default:
              runtimeConfig[key] = {...runtimeConfig[key], ...cfg[key]};
              break;
          }
        });
        log.debug("input config: ", JSON.stringify(cfg,null,4));
        log.debug("runtime config: ", JSON.stringify(runtimeConfig,null,4));
      } catch(err) {
        log.error("Failed to load default network monitor config: ", err);
      }
    }
    return runtimeConfig;
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
      const runtimeState = (typeof systemState === 'undefined' || systemState === null) ? DEFAULT_SYSTEM_POLICY_STATE : systemState;
      const runtimeConfig = this.loadRuntimeConfig(systemConfig || this.config);
      log.debug("runtimeState: ",runtimeState);
      log.debug("runtimeConfig: ",runtimeConfig);
      Object.keys(runtimeConfig).forEach( async targetIP => {
        // always restart to run with latest config
        this.stopMonitorDevice(targetIP);
        if ( runtimeState && this.adminSwitch ) {
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
      //const result = await exec(`ping -c ${cfg.sampleCount} -4 -n ${target}`);
      const data = result.stdout.trim().split(/\n/).map(e => parseFloat(e));
      this.recordSampleDataInRedis(MONITOR_PING, target, timeSlot, data, cfg);
    } catch (err) {
      log.error("failed to sample PING:",err.message);
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
        if (result && result.stdout) {
          data.push(parseInt(result.stdout.trim()));
        }
      }
      this.recordSampleDataInRedis(MONITOR_DNS, target, timeSlot, data, cfg);
    } catch (err) {
      log.error("failed to sample DNS:",err.message);
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
        try {
          const result = await exec(`curl -sk -m 10 -w '%{time_total}\n' '${target}' | tail -1`);
          if (result && result.stdout) {
            data.push(parseFloat(result.stdout.trim()));
          }
        } catch (err2) {
          log.error("curl command failed:",err2);
        }
      }
      this.recordSampleDataInRedis(MONITOR_HTTP, target, timeSlot, data,cfg);
    } catch (err) {
      log.error("failed to sample HTTP:",err.message);
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
    if (!cfg) return;
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

  async getNetworkMonitorData(parse_json=true) {
    log.info("Trying to get network monitor data...")
    try {
      let result = {};
      await rclient.scanAll(`${KEY_PREFIX_RAW}:*`, async (scanResults) => {
        for ( const key of scanResults) {
          const result_json = await rclient.hgetallAsync(key);
          if ( result_json && parse_json ) {
            Object.keys(result_json).forEach( (k)=>{result_json[k] = JSON.parse(result_json[k]) });
          }
          result[key] = result_json;
        }
      },10000);
      return result;
    } catch (err) {
      log.error("failed to get network monitor config: ",err.message);
      return {};
    }
  }

  async apiRun(){
    extensionManager.onGet("networkMonitorData", async (msg,data) => {
      return this.getNetworkMonitorData(data.parse_json);
    });
  }

  getMeanMdev(flist) {
    if (flist.length === 0 ) return [0,0];
    const mean = flist.reduce((sum,x) => sum+x, 0)/flist.length;
    const variance = flist.reduce( (variance,curr) => variance + (curr - mean)*(curr - mean),0 )/flist.length;
    const mdev = Math.sqrt(variance);
    return [ mean, mdev ];
  }

  async checkRTT(monitorType, target, cfg, mean) {
    const statRediskey = `${KEY_PREFIX_STAT}:${monitorType}:${target}`;
    const alertKey = statRediskey+":rtt";
    try {
      const overallMean = await rclient.hgetAsync(statRediskey,"mean");
      const overallMdev = await rclient.hgetAsync(statRediskey,"mdev");
      if (overallMean===null||overallMdev===null) {
        log.warn("no stat data yet in ",statRediskey);
        return;
      }
      // t-score: 1.960(95%) 2.576(99%)
      const meanLimit = Number(overallMean) + cfg.tValue * Number(overallMdev);
      log.debug(`Checking RTT with alertKey(${alertKey}) mean(${mean}) meanLimit(${meanLimit})`);
      if ( mean > meanLimit ) {
        log.warn(`RTT value(${mean}) is over limit(${meanLimit}) in ${alertKey}`);
        if ( ! (this.alerts.hasOwnProperty(alertKey)) ) {
          this.alerts[alertKey] = setTimeout(() => {
            // ONLY sending alarm in Dev
            if ( f.isDevelopmentVersion() ) {
              log.info(`sending alarm on ${alertKey} for RTT mean(${mean}) over meanLimit(${meanLimit})`);
              let alarmDetail = {
                  "p.monitorType": monitorType,
                  "p.target": target,
                  "p.rttLimit": meanLimit,
                  "p.rtt": mean
              }
              if ( monitorType === 'dns' ) {
                alarmDetail["p.lookupName"] = cfg.lookupName;
              }
              const alarm = new Alarm.NetworkMonitorRTTAlarm(new Date() / 1000, null, alarmDetail);
              alarmManager2.enqueueAlarm(alarm);
            }

            // ALWAYS sending event
            let labels = {
              "target":target,
              "rtt":mean,
              "rttLimit":meanLimit
            }
            if ( monitorType === 'dns' ) {
              labels.lookupName = cfg.lookupName;
            }
            era.addActionEvent(`${monitorType}_RTT`,1,labels);

          }, cfg.alarmDelayRTT*1000)
          log.debug(`prepare alert on ${alertKey} to send in ${cfg.alarmDelayRTT} seconds, alerts=`,this.alerts);
        }
      } else {
        if (this.alerts.hasOwnProperty(alertKey)) {
          clearTimeout(this.alerts[alertKey]);
          delete this.alerts[alertKey];
        }
      }
    } catch (err) {
      log.error(`failed to check RTT of ${monitorType}:${target},`,err);
    }
  }

  async checkLossrate(monitorType, target, cfg, lossrate) {
    const alertKey = `${KEY_PREFIX_STAT}:${monitorType}:${target}:lossrate`;
    try {
      log.debug(`Checking lossrate(${lossrate}) against lossrateLimit(${cfg.lossrateLimit}) with alertKey(${alertKey})`);
      if ( lossrate > cfg.lossrateLimit ) {
        log.warn(`Loss rate (${lossrate}) is over limit(${cfg.lossrateLimit}) in ${alertKey}`);
        if ( ! this.alerts.hasOwnProperty(alertKey) ) {
          this.alerts[alertKey] = setTimeout(() => {
            // ONLY sending alarm in Dev
            if ( f.isDevelopmentVersion() ) {
              log.info(`sending alarm on ${alertKey} for lossrate(${lossrate}) over lossrateLimit(${cfg.lossrateLimit})`);
              let alarmDetail = {
                "p.monitorType": monitorType,
                "p.target": target,
                "p.lossrateLimit": cfg.lossrateLimit,
                "p.lossrate": lossrate
              }
              if ( monitorType === 'dns' ) {
                alarmDetail["p.lookupName"] = cfg.lookupName;
              }
              const alarm = new Alarm.NetworkMonitorLossrateAlarm(new Date() / 1000, null, alarmDetail);
              alarmManager2.enqueueAlarm(alarm);
            }

            // ALWAYS sending event
            let labels = {
              "target":target,
              "lossrate":lossrate,
              "lossrateLimit":cfg.lossrateLimit
            }
            if ( monitorType === 'dns' ) {
              labels.lookupName = cfg.lookupName;
            }
            era.addActionEvent(`${monitorType}_lossrate`,1,labels);
          }, cfg.alarmDelayLossrate*1000)
          log.debug(`prepare alert on ${alertKey} to send in ${cfg.alarmDelayLossrate} seconds, alerts=`,this.alerts);
        }
      } else {
        if (this.alerts.hasOwnProperty(alertKey)) {
          clearTimeout(this.alerts[alertKey]);
          delete this.alerts[alertKey];
        }
      }
    } catch (err) {
      log.error(`failed to check loss rate of ${monitorType}:${target},`,err);
    }
  }

  async recordSampleDataInRedis(monitorType, target, timeSlot, data, cfg) {
    const count = cfg.sampleCount;
    const redisKey = `${KEY_PREFIX_RAW}:${monitorType}:${target}`;
    log.debug(`record sample data(${JSON.stringify(data,null,4)}) in ${redisKey} at ${timeSlot}`);
    try {
      const dataSorted = [...data].sort( (a,b) => {
        return a-b
      })
      const l = dataSorted.length;
      let result = null;
      if (l === 0) {
        // no data, 100% loss
        this.checkLossrate(monitorType,target,cfg,1);
        result = {
          "data": data,
          "stat" : {
            "lossrate"  : 1
          }
        }
      } else {
        const [mean,mdev] = this.getMeanMdev(data);
        this.checkRTT(monitorType,target,cfg,mean);
        const lossrate = parseFloat(Number((count-data.length)/count).toFixed(2));
        this.checkLossrate(monitorType,target,cfg,lossrate);
        result = {
          "data": data,
          "stat" : {
            "median": parseFloat(((l%2 === 0) ? (dataSorted[l/2-1]+dataSorted[l/2])/2 : dataSorted[(l-1)/2]).toFixed(1)),
            "min"   : parseFloat(dataSorted[0].toFixed(1)),
            "max"   : parseFloat(dataSorted[l-1].toFixed(1)),
            "mean"  : parseFloat(mean.toFixed(1)),
            "lossrate"  : lossrate
          }
        }
      }
      const resultJSON = JSON.stringify(result);
      log.debug(`record result in ${redisKey} at ${timeSlot}: ${resultJSON}`);
      await rclient.hsetAsync(redisKey, timeSlot, resultJSON);
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
      let allMeans = [];
      let allLossrates = [];
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
            if (result && result.stat) {
              log.debug(`collect data of ${scanKey} at ${ts}`);
              // choose mean for overall stats for estimation
              if ( result.stat.mean ) {
                allMeans.push(parseFloat(result.stat.mean));
              }
              if ( result.stat.lossrate ) {
                allLossrates.push(parseFloat(result.stat.lossrate));
              }
              log.debug("allMeans.length:",allMeans.length);
              log.debug("allLossrates.length:",allLossrates.length);
            }
          }
        }
        scanCursor = parseInt(scanResult[0]);
        if ( scanCursor === 0 ) break; // scan finishes when cursor back to 0
      }

      // calcualte and record stats
      allMeans.sort((a,b) => a-b );
      const l = allMeans.length;
      if (l >= cfg.minSampleRounds) {
        const statKey = `${KEY_PREFIX_STAT}:${monitorType}:${target}`;
        const [mean,mdev] = this.getMeanMdev(allMeans);
        const [lrmean,lrmdev] = this.getMeanMdev(allLossrates);
        log.debug("record stat data at ",statKey);
        await rclient.hsetAsync(statKey, "min", parseFloat(allMeans[0].toFixed(1)));
        await rclient.hsetAsync(statKey, "max", parseFloat(allMeans[l-1].toFixed(1)));
        await rclient.hsetAsync(statKey, "median", parseFloat(((l%2 === 0) ? (allMeans[l/2-1]+allMeans[l/2])/2 : allMeans[(l-1)/2]).toFixed(1)));
        await rclient.hsetAsync(statKey, "mean", parseFloat(mean.toFixed(1)));
        await rclient.hsetAsync(statKey, "mdev", parseFloat(mdev.toFixed(1)));
        await rclient.hsetAsync(statKey, "lrmean", parseFloat(lrmean.toFixed(1)));
        await rclient.hsetAsync(statKey, "lrmdev", parseFloat(lrmdev.toFixed(1)));
      } else {
        log.warn(`not enough rounds(${l} < ${cfg.minSampleRounds}) of sample data to calcualte stats`);
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
