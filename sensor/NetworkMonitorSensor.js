/*    Copyright 2016-2023 Firewalla Inc.
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
const Message = require('../net2/Message.js');

const era = require('../event/EventRequestApi.js');
const Alarm = require('../alarm/Alarm.js');
const AlarmManager2 = require('../alarm/AlarmManager2.js');
const alarmManager2 = new AlarmManager2();
const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();

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
const SAMPLE_INTERVAL_MIN = 60;
const SAMPLE_DEFAULT_OPTS = { "manual": false, "saveResult": true }
const _ = require('lodash');


class NetworkMonitorSensor extends Sensor {

  constructor(config) {
    super(config)
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
  loadRuntimeConfig(cfg, intf) {
    let runtimeConfig = {};
    if (cfg) {
      try {
        log.info("Loading runtime network monitor config ...");
        Object.keys(cfg).forEach ( key => {
          switch (key) {
            case "MY_GATEWAYS":
              // only use gateway of WAN that is currently active
              const gw = intf ? sysManager.myGateway(intf) : sysManager.myDefaultGateway();
              if (gw) {
                runtimeConfig[gw] = {...runtimeConfig[gw], ...cfg[key]};
              }
              break;
            case "MY_DNSES":
              for (const dns of (intf ? sysManager.myDNS(intf) : sysManager.myDefaultDns())) {
                runtimeConfig[dns] = {...runtimeConfig[dns], ...cfg[key]};
              }
              break;
            default:
              runtimeConfig[key] = {...runtimeConfig[key], ...cfg[key]};
              break;
          }
        });
        log.debug(`input config ${intf ? `of ${intf}` : ""}: `, JSON.stringify(cfg,null,4));
        log.debug(`runtime config ${intf ? `of ${intf}` : ""}: `, JSON.stringify(runtimeConfig,null,4));
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
      if ( systemPolicy && Object.keys(systemPolicy).length > 0 ) {
        // always stop ALL existing jobs before apply new policy to avoid leftover jobs of removed targets in old policy
        this.stopMonitorDeviceAll();
        this.applyPolicySystem(systemPolicy);
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

    sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
      log.info("Schedule reload NetworkMonitorSensor since network info is reloaded");
      try {
        // only need to reapply system policy since MY_GATEWAYS and MY_DNSES may be referred
        const systemPolicy = this.cachedPolicy && this.cachedPolicy.system;
        if (systemPolicy) {
          // always stop ALL existing jobs before apply new policy to avoid leftover jobs of removed targets in old policy
          this.stopMonitorDeviceAll();
          this.applyPolicySystem(systemPolicy);
        }
      } catch (err) {
        log.error("Failed to reapply policy of NetworkMonitorSensor after network info is reloaded");
      }
    });

    /*
     * apply policy upon policy change or startup
     */
    extensionManager.registerExtension(POLICY_KEYNAME, this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop
    });

  }

  applyPolicySystem(policy, intfUUID) {
    // for consistency between single WAN and multi-WAN configurations in the app, ignore global config if wanConfs is defined
    const state = policy.state && !policy.wanConfs;
    const config = policy.config;
    let intf = null;
    // for consistency between single WAN and multi-WAN configurations in the app, always run the global test on primary WAN
    if (!intfUUID) {
      const primaryIntf = sysManager.getPrimaryWanInterface();
      intfUUID = primaryIntf && primaryIntf.uuid || null;
    }
    if (intfUUID) {
      const iface = sysManager.getInterfaceViaUUID(intfUUID);
      if (!iface) {
        log.warn(`intferface with uuid ${intfUUID} is not found, will not apply policy on it`);
        return;
      }
      intf = iface.name;
    }
    log.info(`Apply monitoring policy change with state(${state})${intf ? ` on ${intf}` : ""} and config`, config);

    try {
      const runtimeState = (typeof state === 'undefined' || state === null) ? DEFAULT_SYSTEM_POLICY_STATE : state;
      const runtimeConfig = this.loadRuntimeConfig(config || this.config, intf);
      log.debug("runtimeState: ",runtimeState);
      log.debug("runtimeConfig: ",runtimeConfig);
      Object.keys(runtimeConfig).forEach( async targetIP => {
        if (targetIP == "GLOBAL") // GLOBAL job was previously used for cleaning legacy data, it is deprecated as clean job is CPU intensive and legacy data will be automatically cleaned by redis ttl
          return;
        if ( runtimeState && this.adminSwitch ) {
          this.startMonitorDevice(targetIP, targetIP, runtimeConfig[targetIP], intf);
        } else {
          this.stopMonitorDevice(targetIP, intf);
        }
      });

      const wanConfs = policy.wanConfs;
      // apply wan specific jobs embedded in wanConfs
      if (_.isObject(wanConfs)) {
        for (const uuid of Object.keys(wanConfs)) {
          this.applyPolicySystem(wanConfs[uuid], uuid);
        }
      }
    } catch (err) {
      log.error("failed to apply monitoring policy change: ", err);
    }
    return;
  }

  getCfgNumber(cfg,cfgKey,defValue,minValue) {
    let cfgValue = defValue;
    if ( cfgKey in cfg ) {
      if (cfg[cfgKey] >= minValue) {
        cfgValue = cfg[cfgKey];
      } else {
        cfgValue = minValue;
        log.warn(`${cfgKey} value(${cfg[cfgKey]}) too small, use minimum value(${minValue}) instead`);
      }
    } else {
      log.warn(`${cfgKey} undefined, use default value(${defValue}) instead`);
    }
    return cfgValue;
  }

  getCfgString(cfg,cfgKey,defValue) {
    let cfgValue = defValue;
    if ( cfgKey in cfg && /\S/.test(cfg[cfgKey]) ) {
      cfgValue = cfg[cfgKey];
    } else {
      log.warn(`${cfgKey} undefined or blank, use default value(${defValue}) instead`);
    }
    return cfgValue;
  }

  async samplePing(target, cfg, opts) {
    log.debug(`sample PING to ${target}`, opts);
    log.debug("config: ", cfg);
    try {
      const timeNow = Math.floor(Date.now()/1000);
      const timeSlot = ('sampleInterval' in cfg) ?  (timeNow - timeNow % (cfg.sampleInterval)) : timeNow ;
      cfg.sampleTick = this.getCfgNumber(cfg,'sampleTick',1,0.01);
      cfg.sampleCount = this.getCfgNumber(cfg,'sampleCount',20,1);
      let rtid = 0;
      if (opts.intf) {
        const intf = sysManager.getInterface(opts.intf);
        if (!intf || !intf.rtid) {
          log.error(`Cannot find rtid of interface ${intf}, skip ping test on it`);
          return {status: `ERROR: interface ${opts.intf} is not found`, data: {}};
        }
        rtid = intf.rtid;
      }
      const result = await exec(`sudo ping -i ${cfg.sampleTick} ${rtid ? `-m ${rtid}` : ""} -c ${cfg.sampleCount} -W 1 -4 -n ${target}| awk '/time=/ {print $7}' | cut -d= -f2`).catch((err) => {
        log.error(`ping failed on ${target}:`,err.message);
        return null;
      } );
      const data = (result && result.stdout) ?  result.stdout.trim().split(/\n/).map(e => parseFloat(e)) : [];
      return { "status": "OK", "data": await this.recordSampleDataInRedis(MONITOR_PING, target, timeSlot, data, cfg, opts)};
    } catch (err) {
      log.error("failed to sample PING:",err.message);
      return { "status":`ERROR: ${err.message}`, "data": {}};
    }
  }

  async sampleDNS(target, cfg, opts) {
    log.debug(`sample DNS to ${target}`);
    log.debug("config: ", cfg);
    try {
      const timeNow = Math.floor(Date.now()/1000);
      const timeSlot = ('sampleInterval' in cfg) ?  (timeNow - timeNow % (cfg.sampleInterval)) : timeNow ;
      cfg.lookupName = this.getCfgString(cfg,'lookupName','github.com');
      cfg.sampleTick = this.getCfgNumber(cfg,'sampleTick',1,1); // dig does not allow timeout less than 1 second
      let data = [];
      cfg.sampleCount = this.getCfgNumber(cfg,'sampleCount',5,1);
      let bindIP = null;
      if (opts.intf) {
        bindIP = sysManager.myIp(opts.intf);
        if (!bindIP) {
          log.error(`Cannot find IP address to bind on interface ${intf}, skip dns test on it`);
          return {status: `ERROR: ip address on interface ${opts.intf} is not found`, data: {}};
        }
      }
      for (let i=0;i<cfg.sampleCount;i++) {
        const result = await exec(`dig @${target} ${bindIP ? `-b ${bindIP}` : ""} +tries=1 +timeout=${cfg.sampleTick} ${cfg.lookupName} | awk '/Query time:/ {print $4}'`).catch((err) => {
          log.error(`dig failed on ${target}:`,err.message);
          return null;
        } );
        if (result && result.stdout) {
          data.push(parseInt(result.stdout.trim()));
        }
      }
      return { "status": "OK", "data": await this.recordSampleDataInRedis(MONITOR_DNS, target, timeSlot, data, cfg, opts)};
    } catch (err) {
      log.error("failed to sample DNS:",err.message);
      return { "status":`ERROR: ${err.message}`, "data": {}};
    }
  }

  async sampleHTTP(target, cfg, opts) {
    log.debug(`sample HTTP to ${target}`);
    log.debug("config: ", cfg);
    try {
      const timeNow = Math.floor(Date.now()/1000);
      const timeSlot = ('sampleInterval' in cfg) ?  (timeNow - timeNow % (cfg.sampleInterval)) : timeNow ;
      let data = [];
      cfg.sampleCount = this.getCfgNumber(cfg,'sampleCount',5,1);
      let bindIP = null;
      if (opts.intf) {
        bindIP = sysManager.myIp(opts.intf);
        if (!bindIP) {
          log.error(`Cannot find IP address to bind on interface ${intf}, skip http test on it`);
          return {status: `ERROR: ip address on interface ${opts.intf} is not found`, data: {}};
        }
      }
      for (let i=0;i<cfg.sampleCount;i++) {
        try {
          const result = await exec(`curl -sk -m 10 ${bindIP ? `--interface ${bindIP}` : ""} -w '%{time_total}\n' '${target}' | tail -1`).catch((err) => {
            log.error(`curl failed on ${target}:`,err.message);
            return null;
          } );
          if (result && result.stdout) {
            data.push(parseFloat(result.stdout.trim()));
          }
        } catch (err2) {
          log.error("curl command failed:",err2);
        }
      }
      return { "status": "OK", "data": await this.recordSampleDataInRedis(MONITOR_HTTP, target, timeSlot, data,cfg, opts)};
    } catch (err) {
      log.error("failed to sample HTTP:",err.message);
      return { "status":`ERROR: ${err.message}`, "data": {}};
    }
  }

  scheduleSampleJob(monitorType, ip, cfg, intf) {
    log.info(`schedule a sample job ${monitorType}${intf ? ` on ${intf}` : ""} with ip(${ip})`);
    log.debug("config:",cfg);
    let scheduledJob = null;
    // prevent too low value in sample interval
    if (cfg.sampleInterval<SAMPLE_INTERVAL_MIN) {
      log.warn(`sample interval(${cfg.sampleInterval}) too low, using ${SAMPLE_INTERVAL_MIN} instead`);
      cfg.sampleInterval = SAMPLE_INTERVAL_MIN
    }
    const opts = Object.assign({}, SAMPLE_DEFAULT_OPTS);
    if (intf)
      opts.intf = intf;
    switch (monitorType) {
      case MONITOR_PING: {
        scheduledJob = setInterval(() => {
          this.samplePing(ip, cfg, opts);
        }, 1000*cfg.sampleInterval);
        break;
      }
      case MONITOR_DNS: {
        scheduledJob = setInterval(() => {
          this.sampleDNS(ip, cfg, opts);
        }, 1000*cfg.sampleInterval);
        break;
      }
      case MONITOR_HTTP: {
        scheduledJob = setInterval(() => {
          this.sampleHTTP(ip, cfg, opts);
        }, 1000*cfg.sampleInterval);
        break;
      }
    }
    return scheduledJob;
  }

  async sampleOnce(monitorType, ip ,cfg, saveResult, intf) {
    log.info(`run a sample job ${monitorType}${intf ? ` on ${intf}` : ""} with ip(${ip})`);
    log.debug("config:",cfg);
    await hostManager.loadPolicyAsync();
    const hostPolicy = hostManager.policy;
    log.debug("hostPolicy:",hostPolicy);
    let mcfg = cfg;
    if ( hostPolicy && hostPolicy[POLICY_KEYNAME] &&
         hostPolicy[POLICY_KEYNAME]['config'] &&
         hostPolicy[POLICY_KEYNAME]['config'][ip] &&
         hostPolicy[POLICY_KEYNAME]['config'][ip][monitorType] ) {
      mcfg = { ...hostPolicy[POLICY_KEYNAME]['config'][ip][monitorType], ...cfg};
      log.info(`input config merged with system policy:`,mcfg);
    } else {
      mcfg = cfg;
      log.warn(`NO applicable system policy on ${ip} for ${monitorType}, use input config:`,mcfg);
    }
    const opts = SAMPLE_DEFAULT_OPTS;
    opts.manual = true;
    if (intf)
      opts.intf = intf;
    if (typeof saveResult == typeof(true))
      opts.saveResult = saveResult;
    let result = {status:"unknown", data:{}};
    switch (monitorType) {
      case MONITOR_PING:
        result = await this.samplePing(ip,mcfg,opts);
        break;
      case MONITOR_DNS:
        result = await this.sampleDNS(ip,mcfg,opts);
        break;
      case MONITOR_HTTP:
        result = await this.sampleHTTP(ip,mcfg,opts);
        break;
    }
    return result;
  }

  startMonitorDevice(key, ip, cfg, intf = null) {
    log.info(`start monitoring ${key}${intf ? ` on ${intf}` : ""} with ip(${ip})`);
    log.debug("config: ", cfg);
    if (!cfg) return;
    for ( const monitorType of Object.keys(cfg) ) {
      const scheduledKey = `${key}-${monitorType}${intf ? `-${intf}` : ""}`;
      if ( scheduledKey in this.sampleJobs ) {
        log.warn(`${monitorType} on ${key} already started`);
      } else {
        log.debug(`scheduling sample job ${monitorType} on ${key} ...`);
        this.sampleJobs[scheduledKey] = this.scheduleSampleJob(monitorType, ip, cfg[monitorType], intf);
        log.debug(`scheduling process job ${monitorType} on ${key} ...`);
        this.processJobs[scheduledKey] = this.scheduleProcessJob(monitorType, ip, cfg[monitorType], intf);
      }
    }
  }

  stopMonitorDevice(key, intf = null) {
    log.info(`stop monitoring ${key}${intf ? ` on ${intf}` : ""} ...`)
    for ( const monitorType of MONITOR_TYPES ) {
      const scheduledKey = `${key}-${monitorType}${intf ? `-${intf}` : ""}`;
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
    log.info(`stop ALL monitoring jobs ...`)
    Object.keys(this.sampleJobs).forEach( scheduledKey => {
      log.debug(`UNscheduling ${scheduledKey} in sample jobs ...`);
      clearInterval(this.sampleJobs[scheduledKey]);
      delete(this.sampleJobs[scheduledKey]);
    })
    Object.keys(this.processJobs).forEach( scheduledKey => {
      log.debug(`UNscheduling ${scheduledKey} in process jobs ...`);
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
            // always stop ALL existing jobs before apply new policy to avoid leftover jobs of removed targets in old policy
            this.stopMonitorDeviceAll();
            this.applyPolicySystem(policy);
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
          const result_json = await rclient.hgetallAsync(key);
          if ( result_json ) {
            Object.keys(result_json).forEach((k)=>{
              const obj = JSON.parse(result_json[k]);
              result_json[k] = {
                stat: obj.stat
              };
            });
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
      return await this.getNetworkMonitorData();
    });

    extensionManager.onCmd("sampleOnce", async (msg,data) => {
      log.debug("data:",data);
      return await this.sampleOnce(data.monitor_type, data.target, data.config, data.save_result, data.intf);
    });
  }

  getMeanMdev(flist) {
    if (flist.length === 0 ) return [0,0];
    const mean = flist.reduce((sum,x) => sum+x, 0)/flist.length;
    const variance = flist.reduce( (variance,curr) => variance + (curr - mean)*(curr - mean),0 )/flist.length;
    const mdev = Math.sqrt(variance);
    return [ mean, mdev ];
  }

  async checkRTT(monitorType, target, cfg, mean, intfObj) {
    const statRediskey = `${KEY_PREFIX_STAT}:${monitorType}:${target}${intfObj ? `:${intfObj.uuid}` : ""}`;
    const alertKey = statRediskey+":rtt";
    try {
      const [overallMean, overallMdev] = await rclient.hmgetAsync(statRediskey, "mean", "mdev");
      if (overallMean===null||overallMdev===null) {
        log.info("no stat data yet in ",statRediskey);
        return;
      }
      // t-score: 1.960(95%) 2.576(99%)
      const meanLimit = Number(overallMean) + cfg.tValue * Number(overallMdev);
      const minAlarmLatencyMs = cfg.hasOwnProperty("minAlarmLatencyMs") && Number(cfg.minAlarmLatencyMs) || 50;
      const minAlarmLatencyMultiplier = cfg.hasOwnProperty("minAlarmLatencyMultiplier") && Number(cfg.minAlarmLatencyMultiplier) || 4;
      log.debug(`Checking RTT with alertKey(${alertKey}) mean(${mean}) meanLimit(${meanLimit}) ${intfObj ? `on ${intfObj.name}` : ""}`);
      // suppress alarm if sample latency is not significant
      if ( mean > meanLimit && (mean >= minAlarmLatencyMs || mean >= minAlarmLatencyMultiplier * overallMean)) {
        log.warn(`RTT value(${mean}) is over limit(${meanLimit}) in ${alertKey}`);
        if ( ! (this.alerts.hasOwnProperty(alertKey)) ) {
          this.alerts[alertKey] = setTimeout(() => {
            // ONLY sending alarm in Dev
            if ( f.isDevelopmentVersion() && fc.isFeatureOn(`${FEATURE_NETWORK_MONITOR}_alarm`) ) {
              log.info(`sending alarm on ${alertKey} for RTT mean(${mean}) over meanLimit(${meanLimit})`);
              let alarmDetail = {
                  "p.monitorType": monitorType,
                  "p.target": target,
                  "p.rttLimit": meanLimit,
                  "p.rtt": mean
              }
              if (intfObj)
                alarmDetail["p.intf.uuid"] = intfObj.uuid;
              if ( monitorType === 'dns' ) {
                alarmDetail["p.lookupName"] = cfg.lookupName;
              }
              const alarm = new Alarm.NetworkMonitorRTTAlarm(new Date() / 1000, null, alarmDetail);
              alarmManager2.enqueueAlarm(alarm);
            }
          }, cfg.alarmDelayRTT*1000)
          log.debug(`prepare alert on ${alertKey} to send in ${cfg.alarmDelayRTT} seconds, alerts=`,this.alerts);
        }
        // ALWAYS sending event
        let labels = {
          "target":target,
          "rtt":mean,
          "rttLimit":meanLimit
        }
        if (intfObj)
          labels.intfUUID = intfObj.uuid;
        if ( monitorType === 'dns' ) {
          labels.lookupName = cfg.lookupName;
        }
        era.addActionEvent(`${monitorType}_RTT`,1,labels);
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

  async checkLossrate(monitorType, target, cfg, lossrate, intfObj) {
    const alertKey = `${KEY_PREFIX_STAT}:${monitorType}:${target}:lossrate${intfObj ? `:${intfObj.uuid}` : ""}`;
    try {
      log.debug(`Checking lossrate(${lossrate}) against lossrateLimit(${cfg.lossrateLimit}) with alertKey(${alertKey}) ${intfObj ? `on ${intfObj.name}` : ""}`);
      if ( lossrate > cfg.lossrateLimit ) {
        log.warn(`Loss rate (${lossrate}) is over limit(${cfg.lossrateLimit}) in ${alertKey}`);
        if ( ! this.alerts.hasOwnProperty(alertKey) ) {
          this.alerts[alertKey] = setTimeout(() => {
            // ONLY sending alarm in Dev
            if ( f.isDevelopmentVersion() && fc.isFeatureOn(`${FEATURE_NETWORK_MONITOR}_alarm`) ) {
              log.info(`sending alarm on ${alertKey} for lossrate(${lossrate}) over lossrateLimit(${cfg.lossrateLimit})`);
              let alarmDetail = {
                "p.monitorType": monitorType,
                "p.target": target,
                "p.lossrateLimit": cfg.lossrateLimit,
                "p.lossrate": lossrate
              }
              if (intfObj)
                alarmDetail["p.intf.uuid"] = intfObj.uuid;
              if ( monitorType === 'dns' ) {
                alarmDetail["p.lookupName"] = cfg.lookupName;
              }
              const alarm = new Alarm.NetworkMonitorLossrateAlarm(new Date() / 1000, null, alarmDetail);
              alarmManager2.enqueueAlarm(alarm);
            }
          }, cfg.alarmDelayLossrate*1000)
          log.debug(`prepare alert on ${alertKey} to send in ${cfg.alarmDelayLossrate} seconds, alerts=`,this.alerts);
        }
        // ALWAYS sending event
        let labels = {
          "target":target,
          "lossrate":lossrate,
          "lossrateLimit":cfg.lossrateLimit
        }
        if (intfObj)
          labels.intfUUID = intfObj.uuid;
        if ( monitorType === 'dns' ) {
          labels.lookupName = cfg.lookupName;
        }
        era.addActionEvent(`${monitorType}_lossrate`,1,labels);
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

  async recordSampleDataInRedis(monitorType, target, timeSlot, data, cfg, opts) {
    const count = cfg.sampleCount;
    let intfObj = null;
    if (opts.intf) {
      intfObj = sysManager.getInterface(opts.intf);
      if (!intfObj || !intfObj.uuid) {
        log.error(`Interface ${intfObj} is not found, cannot record sample data`);
        return;
      }
    }
    const redisKey = `${KEY_PREFIX_RAW}:${monitorType}:${target}${intfObj ? `:${intfObj.uuid}` : ""}`;
    let result = null;
    log.debug(`record sample data(${JSON.stringify(data,null,4)}) in ${redisKey} at ${timeSlot}`);
    try {
      const dataSorted = [...data].sort( (a,b) => {
        return a-b
      })
      const l = dataSorted.length;
      if (l === 0) {
        // no data, 100% loss
        this.checkLossrate(monitorType,target,cfg,1);
        result = {
          "data": data,
          "manual": (opts && opts.manual) ? opts.manual : false,
          "stat" : {
            "lossrate"  : 1
          }
        }
      } else {
        const [mean,mdev] = this.getMeanMdev(data);
        this.checkRTT(monitorType, target, cfg, mean, intfObj);
        const lossrate = parseFloat(Number((count-data.length)/count).toFixed(4));
        this.checkLossrate(monitorType, target, cfg, lossrate, intfObj);
        result = {
          "data": data,
          "manual": (opts && opts.manual) ? opts.manual : false,
          "stat" : {
            "median": parseFloat(((l%2 === 0) ? (dataSorted[l/2-1]+dataSorted[l/2])/2 : dataSorted[(l-1)/2]).toFixed(1)),
            "min"   : parseFloat(dataSorted[0].toFixed(1)),
            "max"   : parseFloat(dataSorted[l-1].toFixed(1)),
            "mean"  : parseFloat(mean.toFixed(1)),
            "lossrate"  : lossrate
          }
        }
      }
      if (!opts || opts.saveResult !== false) {
        const resultJSON = JSON.stringify(result);
        log.debug(`record result in ${redisKey} at ${timeSlot}: ${resultJSON}`);
        await rclient.hsetAsync(redisKey, timeSlot, resultJSON);
        await rclient.expireAsync(redisKey, 2 * cfg.expirePeriod);
      }
    } catch (err) {
      log.error("failed to record sample data of ${moitorType} for ${target} :", err);
    }
    return result;
  }

  async processJob(monitorType,target,cfg, intf) {
    log.debug(`start process ${monitorType} data for ${target}`);
    log.debug("config: ", cfg);
    let intfObj = null;
    if (intf) {
      intfObj = sysManager.getInterface(intf);
      if (!intfObj) {
        log.error(`Cannot find interface ${intf}, skip process job on it`);
        return;
      }
    }
    try {
      const expireTS = Math.floor(Date.now()/1000) - cfg.expirePeriod;
      const scanKey = `${KEY_PREFIX_RAW}:${monitorType}:${target}${intfObj ? `:${intfObj.uuid}` : ""}`;
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
      const l = allMeans.length
      if (l >= cfg.minSampleRounds) {
        const statKey = `${KEY_PREFIX_STAT}:${monitorType}:${target}${intfObj ? `:${intfObj.uuid}` : ""}`;
        const [mean,mdev] = this.getMeanMdev(allMeans);
        const [lrmean,lrmdev] = this.getMeanMdev(allLossrates);
        log.debug("record stat data at ",statKey);
        await rclient.hsetAsync(statKey, "min", parseFloat(allMeans[0].toFixed(1)));
        await rclient.hsetAsync(statKey, "max", parseFloat(allMeans[l-1].toFixed(1)));
        await rclient.hsetAsync(statKey, "median", parseFloat(((l%2 === 0) ? (allMeans[l/2-1]+allMeans[l/2])/2 : allMeans[(l-1)/2]).toFixed(1)));
        await rclient.hsetAsync(statKey, "mean", parseFloat(mean.toFixed(1)));
        await rclient.hsetAsync(statKey, "mdev", parseFloat(mdev.toFixed(1)));
        await rclient.hsetAsync(statKey, "lrmean", parseFloat(lrmean.toFixed(4)));
        await rclient.hsetAsync(statKey, "lrmdev", parseFloat(lrmdev.toFixed(4)));
        await rclient.expireAsync(statKey, 2 * cfg.expirePeriod);
      } else {
        log.warn(`not enough rounds(${l} < ${cfg.minSampleRounds}) of sample data to calcualte stats`);
      }
    } catch (err) {
      log.error(`failed to process data of ${monitorType} for target(${target}): `,err);
    }
  }

  scheduleProcessJob(monitorType, ip, cfg, intf) {
    log.info(`scheduling process job for ${monitorType}${intf ? ` on ${intf}` : ""} with ip(${ip})`);
    log.debug("config: ",cfg);
    const scheduledJob = setInterval(() => {
      this.processJob(monitorType, ip, cfg, intf);
    }, 1000*cfg.processInterval);
    return scheduledJob;
  }

}

module.exports = NetworkMonitorSensor;
