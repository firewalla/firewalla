/*    Copyright 2016-2020 Firewalla Inc.
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
const log = require("../net2/logger.js")(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()

const FlowManager = require('../net2/FlowManager.js');
const flowManager = new FlowManager('info');

const Alarm = require('../alarm/Alarm.js');
const AlarmManager2 = require('../alarm/AlarmManager2.js');
const alarmManager2 = new AlarmManager2();

const fc = require('../net2/config.js')

const uuid = require('uuid');

const HostTool = require('../net2/HostTool')
const hostTool = new HostTool()

let instance = null;
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();

const IdentityManager = require('../net2/IdentityManager.js');

const default_stddev_limit = 8;
const default_inbound_min_length = 1000000;
const deafult_outbound_min_length = 500000;

const IntelManager = require('../net2/IntelManager.js');
const intelManager = new IntelManager('debug');

const sysManager = require('../net2/SysManager.js');

const fConfig = require('../net2/config.js').getConfig();

const flowUtil = require('../net2/FlowUtil.js');
const f = require('../net2/Firewalla.js');

const validator = require('validator');

const URL = require('url');

const _ = require('lodash');

function getDomain(ip) {
  if (ip.endsWith(".com") || ip.endsWith(".edu") || ip.endsWith(".us") || ip.endsWith(".org")) {
    let splited = ip.split(".");
    if (splited.length >= 3) {
      return (splited[splited.length - 2] + "." + splited[splited.length - 1]);
    }
  }
  return ip;
}

function alarmBootstrap(flow, mac) {
  const obj = {
    "p.device.id": flow.shname,
    "p.device.name": flow.shname,
    "p.device.ip": flow.sh,
    "p.protocol": flow.pr,
    "p.dest.name": flowUtil.dhnameFlow(flow),
    "p.dest.ip": flow.dh,
    "p.dest.port": flow.dp,
    "p.intf.id": flow.intf,
    "p.tag.ids": flow.tags
  }

  if (flow.rl)
    obj["p.device.real.ip"] = flow.rl;

  if (flow.guid) {
    const identity = IdentityManager.getIdentityByGUID(flow.guid);
    if (identity)
      obj[identity.constructor.getKeyOfUIDInAlarm()] = identity.getUniqueId();
    obj["p.device.guid"] = flow.guid;
  }

  if(mac) {
    obj["p.dest.ip.device.mac"] = mac;
  }

  // in case p.device.mac is not obtained from DeviceInfoIntel
  if (!obj.hasOwnProperty("p.device.mac") && mac)
    obj["p.device.mac"] = mac;

  return obj;
}

module.exports = class FlowMonitor {
  constructor(timeslice, monitorTime, loglevel) {
    this.timeslice = timeslice; // in seconds
    this.monitorTime = monitorTime;

    if (instance == null) {
      let c = require('../net2/MessageBus.js');
      this.publisher = new c(loglevel);
      this.recordedFlows = {};

      instance = this;
    }

    // largeTransferGuard stores the latest flow time for each device/dest.ip/dest.port
    // combination, aim to elimates duplicate LargeTransferAlarm
    if (!this.largeTransferGuard) this.largeTransferGuard = {};

    return instance;
  }

  // flow record is a very simple way to look back past n seconds,
  // if 'av' for example, shows up too many times ... likely to be
  // av

  flowIntelRecordFlow(flow, limit) {
    let key = flow.dh;
    if (flow["dhname"] != null) {
      key = getDomain(flow["dhname"]);
    }
    let record = this.recordedFlows[key];
    if (record) {
      record.ts = Date.now() / 1000;
      record.count += flow.ct;
    } else {
      record = {}
      record.ts = Date.now() / 1000;
      record.count = flow.ct;
      this.recordedFlows[key] = record;
    }
    // clean  up
    let oldrecords = [];
    for (let k in this.recordedFlows) {
      if (this.recordedFlows[k].ts < Date.now() / 1000 - 60 * 5) {
        oldrecords.push(k);
      }
    }

    for (let i in oldrecords) {
      delete this.recordedFlows[oldrecords[i]];
    }

    log.info("FLOW:INTEL:RECORD", key, record);
    if (record.count > limit) {
      record.count = 0 - limit;
      return true;
    }
    return false;
  }

  garbagecollect() {
    try {
      if (global.gc) {
        global.gc();
      }
    } catch (e) {
    }
  }

  isFlowIntelInClass(intel, classes) {
    if (!intel || !classes) {
      return false;
    }

    if (!Array.isArray(classes)) {
      classes = [classes];
    }

    const intelFeatureMapping = {
      "av": "video",
      "games": "game",
      "porn": "porn",
      "vpn": "vpn",
      "intel": "cyber_security",
      'spam': "cyber_security",
      'phishing': "cyber_security",
      'piracy': "cyber_security",
      'suspicious': "cyber_security"
    }

    let enabled = classes.map(c => {
      const featureName = intelFeatureMapping[c];
      if (!featureName) {
        return false;
      }
      if (!fc.isFeatureOn(featureName)) {
        log.debug(`Feature ${featureName} is not enabled`);
        return false;
      }
      return true;
    }).reduce((acc, cur) => acc || cur);

    if (!enabled) {
      return false;
    }

    if (classes.includes(intel.category)) {
      return true;
    } else {
      if (classes.includes("intel")) { // for security alarm, category must equal to 'intel'
        return false;
      }
    }

    if (classes.includes(intel.c)) {
      return true;
    }

    function isMatch(_classes, v) {
      let matched;
      try {
        let _v = new Set(Array.isArray(v) ? v : JSON.parse(v));
        matched = _classes.filter(x => _v.has(x)).length > 0;
      } catch (err) {
        log.warn("Error when match classes", _classes, "with value", v, err);
      }
      return matched;
    }

    if (intel.cs && isMatch(classes, intel.cs)) {
      return true;
    }

    if (intel.cc && isMatch(classes, intel.cc)) {
      return true;
    }

    return false;
  }

  flowIntel(flows, mac) {
    for (const flow of flows) {
      log.debug("FLOW:INTEL:PROCESSING", JSON.stringify(flow));
      if (flow.intel && flow.intel.category && !flowUtil.checkFlag(flow, 'l')) {
        log.debug("######## flowIntel Processing", JSON.stringify(flow));
        if (this.isFlowIntelInClass(flow['intel'], "av") &&
          flow.fd === 'in') {
          if ((flow.du && Number(flow.du) > 60) && (flow.rb && Number(flow.rb) > 5000000)) {
            let alarm = new Alarm.VideoAlarm(flow.ts, flow["shname"], flowUtil.dhnameFlow(flow),
              alarmBootstrap(flow, mac)
            );

            alarmManager2.enqueueAlarm(alarm);
          }
        }
        else if (
          this.isFlowIntelInClass(flow['intel'], "porn") &&
          flow.fd === 'in' &&
          (
            (flow.du && Number(flow.du) > 20) && (flow.rb && Number(flow.rb) > 1000000) ||
            this.flowIntelRecordFlow(flow, 3)
          )
        ) {

          // there should be a unique ID between pi and cloud on websites

          let alarm = new Alarm.PornAlarm(flow.ts, flow["shname"], flowUtil.dhnameFlow(flow),
            alarmBootstrap(flow, mac)
          );

          alarmManager2.enqueueAlarm(alarm);
        }
        else if (this.isFlowIntelInClass(flow['intel'], ['intel', 'suspicious', 'piracy', 'phishing', 'spam'])) {
          // Intel object
          //     {"ts":1466353908.736661,"uid":"CYnvWc3enJjQC9w5y2","id.orig_h":"192.168.2.153","id.orig_p":58515,"id.resp_h":"98.124.243.43","id.resp_p":80,"seen.indicator":"streamhd24.com","seen
          //.indicator_type":"Intel::DOMAIN","seen.where":"HTTP::IN_HOST_HEADER","seen.node":"bro","sources":["from http://spam404bl.com/spam404scamlist.txt via intel.criticalstack.com"]}
          // ignore partial flows initiated from outside.  They are blocked by firewall and we
          // see the packet before that due to how libpcap works

          if (flowUtil.checkFlag(flow, 's') && flow.fd === "out") {
            log.info("Intel:On:Partial:Flows", flow);
          } else {
            let intelobj = {
              uid: uuid.v4(),
              ts: flow.ts,
              fd: flow.fd,
              intel: flow.intel,
              sp_array: flow.sp_array,
              "seen.indicator_type": "Intel::DOMAIN",
            };

            if ("urls" in flow) {
              intelobj.urls = flow.urls;
            }

            if (flow.fd === "in") {
              Object.assign(intelobj, {
                "id.orig_h": flow.sh,
                "id.resp_h": flow.dh,
                "id.orig_p": flow.sp,
                "id.resp_p": flow.dp,
              });

              if (flow.dhname) {
                intelobj['seen.indicator'] = flow.dhname;
              } else {
                intelobj['seen.indicator'] = flow.dh;
              }
            } else {
              Object.assign(intelobj, {
                shname: flow["shname"],
                dhname: flow["dhname"],
                mac: flow["mac"],
                target: flow.lh,
                appr: flow["appr"],
                org: flow["org"],
                "id.orig_h": flow.dh,
                "id.resp_h": flow.sh,
                "id.orig_p": flow.dp,
                "id.resp_p": flow.sp
              });

              if (flow.shname) {
                intelobj['seen.indicator'] = flow.shname;
              } else {
                intelobj['seen.indicator'] = flow.sh;
              }
            }

            if (flow.intel && flow.intel.action) {
              intelobj.action = flow.intel.action;
            }
            if (flow.intel && flow.intel.cc) {
              intelobj.categoryArray = flow.intel.cc;
            }

            if (flow.pr) {
              intelobj.pr = flow.pr;
            }

            if (flow.intf && _.isString(flow.intf)) {
              intelobj.intf = flow.intf;
            }
            if (flow.tags && _.isArray(flow.tags)) {
              intelobj.tags = flow.tags;
            }

            if (flow.guid) {
              intelobj.guid = flow.guid;
            }

            if (flow.rl)
              intelobj.rl = flow.rl;

            log.info("Intel:Flow Sending Intel", JSON.stringify(intelobj));

            this.publisher.publish("DiscoveryEvent", "Intel:Detected", intelobj['id.orig_h'], intelobj);
            this.publisher.publish("DiscoveryEvent", "Intel:Detected", intelobj['id.resp_h'], intelobj);

            // Process intel to generate Alarm about it
            this.processIntelFlow(intelobj);
          }
        }
        else if (
          this.isFlowIntelInClass(flow['intel'], "games") &&
          flow.fd === 'in' &&
          (
            (flow.du && Number(flow.du) > 3) && (flow.rb && Number(flow.rb) > 30000) ||
            this.flowIntelRecordFlow(flow, 3)
          )
        ) {
          let alarm = new Alarm.GameAlarm(flow.ts, flow["shname"], flowUtil.dhnameFlow(flow),
            alarmBootstrap(flow, mac)
          );

          alarmManager2.enqueueAlarm(alarm);
        }
        else if (
          this.isFlowIntelInClass(flow['intel'], "vpn") &&
          flow.fd === 'in' &&
          (
            (flow.du && Number(flow.du) > 120) && (flow.rb && Number(flow.rb) > 10000) ||
            this.flowIntelRecordFlow(flow, 3)
          )
        ) {
          let alarm = new Alarm.VpnAlarm(flow.ts, flow["shname"], flowUtil.dhnameFlow(flow),
            alarmBootstrap(flow, mac)
          );

          alarmManager2.enqueueAlarm(alarm);
        }
      }
    }
  }

  // summarize will
  // neighbor:<mac>:ip:
  //  {ip: {
  //      ts: ..
  //      count: ...
  //  }
  //  {host: ...}
  // neighbor:<mac>:host:
  //   {set: host}

  //   '17.253.4.125': '{"neighbor":"17.253.4.125","cts":1481438191.098,"ts":1481990573.168,"count":356,"rb":33984,"ob":33504,"du":27.038723000000005,"name":"time-ios.apple.com"}',
  //  '17.249.9.246': '{"neighbor":"17.249.9.246","cts":1481259330.564,"ts":1482050353.467,"count":348,"rb":1816075,"ob":1307870,"du":10285.943863000004,"name":"api-glb-sjc.smoot.apple.com"}',
  summarizeNeighbors(host, flows) {
    let key = "neighbor:" + host.o.mac;
    log.debug("Summarizing Neighbors ", flows.length, key);


    rclient.hgetall(key, (err, data) => {
      let neighborArray = [];
      if (data == null) {
        data = {};
      } else {
        for (let n in data) {
          try {
            data[n] = JSON.parse(data[n]);
            data[n].neighbor = n;
            neighborArray.push(data[n]);
          } catch (e) {
            log.warn('parse neighbor data error', data[n], key);
          }
        }
      }
      let now = Date.now() / 1000;
      for (let f in flows) {
        let flow = flows[f];
        let neighbor = flow.dh;
        let ob = flow.ob;
        let rb = flow.rb;
        let du = flow.du;
        let name = flow.dhname;
        if (flow.lh == flow.dh) {
          neighbor = flow.sh;
          ob = flow.rb;
          rb = flow.ob;
          name = flow.shname;
        }
        if (data[neighbor] != null) {
          data[neighbor]['ts'] = now;
          data[neighbor]['count'] += 1;
          data[neighbor]['rb'] += rb;
          data[neighbor]['ob'] += ob;
          data[neighbor]['du'] += du;
          data[neighbor]['neighbor'] = neighbor;
        } else {
          data[neighbor] = {};
          data[neighbor]['neighbor'] = neighbor;
          data[neighbor]['cts'] = now;
          data[neighbor]['ts'] = now;
          data[neighbor]['count'] = 1;
          data[neighbor]['rb'] = rb;
          data[neighbor]['ob'] = ob;
          data[neighbor]['du'] = du;
          neighborArray.push(data[neighbor]);
        }
        if (name) {
          data[neighbor]['name'] = name;
        }
      }
      let savedData = {};

      //chop the minor ones
      neighborArray.sort(function (a, b) {
        return Number(b.count) - Number(a.count);
      })
      let max = 20;

      let deletedArrayCount = neighborArray.slice(max + 1);
      let neighborArrayCount = neighborArray.slice(0, max);

      neighborArray.sort(function (a, b) {
        return Number(b.ts) - Number(a.ts);
      })

      let deletedArrayTs = neighborArray.slice(max + 1);
      let neighborArrayTs = neighborArray.slice(0, max);

      deletedArrayCount = deletedArrayCount.filter((val) => {
        return neighborArrayTs.indexOf(val) == -1;
      });
      deletedArrayTs = deletedArrayTs.filter((val) => {
        return neighborArrayCount.indexOf(val) == -1;
      });

      let deletedArray = deletedArrayCount.concat(deletedArrayTs);

      log.debug("Neighbor:Summary:Deleted", deletedArray);

      let addedArray = neighborArrayCount.concat(neighborArrayTs);

      log.debug("Neighbor:Summary", key, deletedArray.length, addedArray.length, deletedArrayTs.length, neighborArrayTs.length, deletedArrayCount.length, neighborArrayCount.length);

      for (let i in deletedArray) {
        rclient.hdel(key, deletedArray[i].neighbor);
      }

      for (let i in addedArray) {
        // need to delete things not here
        savedData[addedArray[i].neighbor] = addedArray[i];
      }

      for (let i in savedData) {
        savedData[i] = JSON.stringify(data[i]);
      }
      rclient.hmset(key, savedData, (err, d) => {
        log.debug("Set Host Summary", key, savedData, d);
        let expiring = fConfig.sensors.OldDataCleanSensor.neighbor.expires || 24 * 60 * 60 * 7;  // seven days
        rclient.expireat(key, parseInt((+new Date) / 1000) + expiring);
      });
    });
  }

  updateIntelFromHTTP(conn) {
    delete conn.uids;
    const urls = conn.urls;
    if (!_.isEmpty(urls) && conn.intel && conn.intel.c !== 'intel') {
      for (const url of urls) {
        if (url && url.category === 'intel') {
          for (const key of ["category", "cc", "cs", "t", "v", "s", "updateTime"]) {
            conn.intel[key] = url[key];
          }
          const parsedInfo = URL.parse(url.url);
          if (parsedInfo && parsedInfo.hostname) {
            conn.intel.host = parsedInfo.hostname;
          }
          conn.intel.fromURL = "1";
          break;
        }
      }
    }
  }

  async detect(mac, period, host) {
    let end = Date.now() / 1000;
    let start = end - period; // in seconds
    //log.info("Detect",listip);
    let result = await flowManager.summarizeConnections(mac, "in", end, start, "time", this.monitorTime / 60.0 / 60.0, true, true);
    await flowManager.enrichHttpFlowsInfo(result.connections);
    if (!_.isEmpty(result.connections)) {
      result.connections.forEach((conn) => {
        this.updateIntelFromHTTP(conn);
      });
    }

    this.flowIntel(result.connections, mac);
    if (host)
      this.summarizeNeighbors(host, result.connections);
    if (result.activities != null) {
      /*
      if (host.activities!=null) {
          if (host.activities.app && host.activities.app.length >0) {
              host.activities.app = activities.app.concat(host.activities.app);
          }
          if (host.activities.activity && host.activities.activity.length >0) {
              host.activities.activity = activities.activity.concat(host.activities.activity);
          }
      } else {
          host.activities = activities;
      }
      host.save("activities",null);
      */
      if (host) {
        host.activities = result.activities;
        host.save("activities", null);
      }
    }
    result = await flowManager.summarizeConnections(mac, "out", end, start, "time", this.monitorTime / 60.0 / 60.0, true, true);
    await flowManager.enrichHttpFlowsInfo(result.connections);
    if (!_.isEmpty(result.connections)) {
      result.connections.forEach((conn) => {
        this.updateIntelFromHTTP(conn);
      });
    }
    this.flowIntel(result.connections, mac);
    if (host)
      this.summarizeNeighbors(host, result.connections);
  }


  async getFlowSpecs(host) {
    const mac = host.o.mac;
    // this function wakes up every 15 min and watch past 8 hours... this is the reason start and end is 8 hours appart
    let end = Date.now() / 1000;
    let start = end - this.monitorTime; // in seconds
    let result = await flowManager.summarizeConnections(mac, "in", end, start, "time", this.monitorTime / 60.0 / 60.0, true, false);

    let inbound_min_length = default_inbound_min_length;
    let outbound_min_length = deafult_outbound_min_length;
    let stddev_limit = default_stddev_limit;

    if (fc.isFeatureOn("insane_mode")) {
      log.warn("INSANE MODE ON");
      inbound_min_length = 1000;
      outbound_min_length = 1000;
      stddev_limit = 1;
    }

    let inSpec = flowManager.getFlowCharacteristics(result.connections, "in", inbound_min_length, stddev_limit);
    if (result.activities != null) {
      host.activities = result.activities;
      host.save("activities", null);
    }
    result = await flowManager.summarizeConnections(mac, "out", end, start, "time", this.monitorTime / 60.0 / 60.0, true, false);
    let outSpec = flowManager.getFlowCharacteristics(result.connections, "out", outbound_min_length, stddev_limit);
    return { inSpec, outSpec };
  }

  //
  // monitor:flow:ip:<>: <ts score> / { notification }
  //

  async saveSpecFlow(direction, ip, flow) {
    let key = "monitor:flow:" + direction + ":" + ip;
    let strdata = JSON.stringify(flow);
    let redisObj = [key, flow.nts, strdata];
    log.debug("monitor:flow:save", redisObj);
    return rclient.zaddAsync(redisObj);
  }

  async processSpec(direction, rankedFlows) {
    for (let i in rankedFlows) {
      let flow = rankedFlows[i];
      flow.rank = i;
      let ip = flow.sh;
      if (direction == 'out') {
        ip = flow.dh;
      }
      let key = "monitor:flow:" + direction + ":" + ip;
      let fullkey = "monitor:flow:" + direction + ":" + flow.sh + ":" + flow.dh;
      log.debug("monitor:flow", key);
      let now = Date.now() / 1000;
      let results = await rclient.zrevrangebyscoreAsync(key, now, now - 60 * 60 * 8);

      if (results && results.length > 0) {
        log.debug("monitor:flow:found", results);
        let found = false;
        for (let i in results) {
          let _flow = JSON.parse(results[i]);
          if (_flow.sh == flow.sh && _flow.dh == flow.dh) {
            found = true;
            break;
          }
        }
        if (this.fcache[fullkey] != null) {
          found = true;
        }

        if (found) {
          log.debug("monitor:flow:duplicated", key);
          continue; // to next entry in rankedFlows
        }
      }

      flow.nts = Date.now() / 1000;
      this.fcache[fullkey] = flow;

      try {
        await this.saveSpecFlow(direction, ip, flow);
      } catch (err) {
        log.error('Failed to save flow', fullkey, err);
      }

      try {
        await this.genLargeTransferAlarm(direction, flow);
      } catch (err) {
        log.error('Failed to generate alarm', fullkey, err);
      }
    }
  }

  /* Sample Spec
  Monitor:Flow:In MonitorEvent 192.168.2.225 { direction: 'in',
    txRanked:
     [ { ts: 1466695174.518089,
         sh: '192.168.2.225',
         dh: '52.37.161.188',
         ob: 45449694,
         rb: 22012400,
         ct: 13705,
         fd: 'in',
         lh: '192.168.2.225',
         du: 1176.5127850000029,
         bl: 0,
         shname: 'raspbNetworkScan',
         dhname: 'iot.encipher.io',
         org: '!',
         txratio: 2.0647314241064127 } ],
    rxRanked:
  */

  async run(service, period, options) {
    options = options || {};

    let runid = new Date() / 1000
    log.info("Starting:", service, service == 'dlp' ? this.monitorTime : period, runid);
    const startTime = new Date() / 1000

    try {
      let hosts = await hostManager.getHostsAsync();

      this.fcache = {}; //temporary cache preventing sending duplicates, while redis is writting to disk
      hosts = hosts.filter(x => x) // workaround if host is undefined or null
      for (const host of hosts) {
        const mac = host.o.mac;

        // if mac is pre-specified and mac does not equal to 
        if(options.mac && options.mac !== mac) {
          continue;
        }

        if (!service || service === "dlp") {
          log.info("Running DLP", mac);
          // aggregation time window set on FlowMonitor instance creation
          const { inSpec, outSpec } = await this.getFlowSpecs(host);
          log.debug("monitor:flow:", host.toShortString());
          log.debug("inspec", inSpec);
          log.debug("outspec", outSpec);

          for (let spec of [inSpec, outSpec]) {
            if (!spec) continue;

            if (
              spec.txRanked && spec.txRanked.length > 0 ||
              spec.rxRanked && spec.rxRanked.length > 0 ||
              spec.txRatioRanked && spec.txRatioRanked.length > 0
            ) {
              await this.processSpec(spec.direction, spec.txRatioRanked);
            }
          }
        }
        else if (service === "detect") {
          if (mac) {
            log.info("Running Detect:", mac);
          }
          await this.detect(mac, period, host);
        }
      }

      if (service === "detect") {
        const guids = IdentityManager.getAllIdentitiesGUID();
        for (const guid of guids) {
          if (options.mac && options.mac !== guid)
            continue;
          log.info("Running Detect:", guid);
          await this.detect(guid, period);
        }
      }
    } catch (e) {
      log.error('Error in run', service, period, runid, e);
    } finally {
      const endTime = new Date() / 1000
      log.info(`Run ends with ${Math.floor(endTime - startTime)} seconds :`, service, period, runid);
      this.garbagecollect();
    }
  }
  // Reslve v6 or v4 address into a local host


  async genLargeTransferAlarm(direction, flow) {
    if (!flow) return;

    let copy = JSON.parse(JSON.stringify(flow));

    if (direction === 'out') {
      copy.sh = flow.dh;
      copy.shname = flow.dhname;
      copy.sp = flow.dp;

      copy.dh = flow.sh;
      copy.dhname = flow.shname;
      copy.dp = flow.sp;

      copy.ob = flow.rb;
      copy.rb = flow.ob;
    }

    const {ddns, publicIp} = await rclient.hgetallAsync("sys:network:info");
    if (ddns == copy.dname || publicIp == copy.dh) return;
    
    let msg = "Warning: " + flowManager.toStringShortShort2(flow, direction, 'txdata');
    copy.msg = msg;

    if (fc.isFeatureOn("large_upload")) {
      // flow in means connection initiated from inside
      // flow out means connection initiated from outside (more dangerous)

      // clear obsoleted data in largeTransferGuard
      for (let k in this.largeTransferGuard) {
        if (this.largeTransferGuard[k] < Date.now() / 1000 - this.monitorTime * 2)
          delete this.largeTransferGuard[k];
      }

      if (copy.ets < Date.now() / 1000 - this.monitorTime * 2) {
        log.warn('Traffic out of scope, drop', JSON.stringify(copy))
        return
      }

      // prevent alarm generation if summed flow starts before last alarm flow ends
      let guardKey = `${copy.sh}:${copy.dh}`;
      if (this.largeTransferGuard[guardKey] > copy.ts) {
        log.warn(`LargeTransferAlarm Guarded: ${guardKey} started ${copy.ts}, last one ended: ${this.largeTransferGuard[guardKey]}`);
        return;
      }

      this.largeTransferGuard[guardKey] = copy.ets;

      let alarm = new Alarm.LargeTransferAlarm(copy.ts, copy.shname, copy.dhname || copy.dh, {
        "p.device.id": copy.shname,
        "p.device.name": copy.shname,
        "p.device.ip": copy.sh,
        "p.device.port": copy.sp || 0,
        "p.dest.name": copy.dhname || copy.dh,
        "p.dest.ip": copy.dh,
        "p.dest.port": copy.dp,
        "p.protocol": copy.pr,
        "p.transfer.outbound.size": copy.ob,
        "p.transfer.inbound.size": copy.rb,
        "p.transfer.duration": copy.du,
        "p.local_is_client": direction == 'in' ? "1" : "0", // connection is initiated from local
        "p.flow": JSON.stringify(flow),
        "p.intf.id": flow.intf,
        "p.tag.ids": flow.tags
      });

      // ideally each destination should have a unique ID, now just use hostname as a workaround
      // so destionationName, destionationHostname, destionationID are the same for now

      alarmManager2.enqueueAlarm(alarm);
    }
  }

  getDeviceIP(obj) {
    if (sysManager.isLocalIP(obj['id.orig_h'])) {
      return obj['id.orig_h'];
    } else {
      return obj['id.resp_h'];
    }
  }

  getRemoteIP(obj) {
    if (!sysManager.isLocalIP(obj['id.orig_h'])) {
      return obj['id.orig_h'];
    } else {
      return obj['id.resp_h'];
    }
  }

  getDevicePort(obj) {
    let port = null;
    if (sysManager.isLocalIP(obj['id.orig_h'])) {
      port = obj['id.orig_p'];
    } else {
      port = obj['id.resp_p'];
    }
    if (port.constructor.name === 'Array' && port.length > 0) {
      return port[0];
    } else {
      return port;
    }
  }

  getDevicePorts(obj) {
    if (sysManager.isLocalIP(obj['id.orig_h'])) {
      return obj['sp_array'];
    } else {
      return [obj['id.resp_p']];
    }
  }

  getRemotePort(obj) {
    let port = null;

    if (!sysManager.isLocalIP(obj['id.orig_h'])) {
      port = obj['id.orig_p'];
    } else {
      port = obj['id.resp_p'];
    }

    if (port.constructor.name === 'Array' && port.length > 0) {
      return port[0];
    } else {
      return port;
    }
  }

  getRemotePorts(obj) {
    if (!sysManager.isLocalIP(obj['id.orig_h'])) {
      return obj['sp_array'];
    } else {
      return [obj['id.resp_p']];
    }
  }

  async processIntelFlow(flowObj) {
    log.info("Process intel flow for", flowObj);
    const deviceIP = this.getDeviceIP(flowObj);
    const remoteIP = this.getRemoteIP(flowObj);

    if (sysManager.isLocalIP(remoteIP)) {
      log.error("Host:Subscriber:Intel Error related to local ip", remoteIP);
      return;
    }

    let success;
    try {
      success = await this.checkDomainAlarm(remoteIP, deviceIP, flowObj);
    } catch (err) {
      log.error("Error when check domain alarm", err);
    }

    if (success) {
      log.info("Successfully triggered domain alarm, skip IP alarm triggering");
      return;
    }

    try {
      await this.checkIpAlarm(remoteIP, deviceIP, flowObj);
    } catch (err) {
      log.error("Error when check IP alarm", err);
    }
  }


  updateURLPart(alarmPayload, flowObj) {
    if ("urls" in flowObj) {
      if (flowObj.fd === 'in') {
        alarmPayload["p.dest.urls"] = flowObj.urls;

        if (!_.isEmpty(flowObj.urls) && flowObj.urls[0].url) {
          alarmPayload["p.dest.url"] = `http://${flowObj.urls[0].url}`;
        }
      } else {

        alarmPayload["p.device.urls"] = flowObj.urls;
        if (!_.isEmpty(flowObj.urls) && flowObj.urls[0].url) {
          alarmPayload["p.device.url"] = `http://${flowObj.urls[0].url}`;
        }
      }
    }
  }

  async checkDomainAlarm(remoteIP, deviceIP, flowObj) {
    if (!fc.isFeatureOn("cyber_security")) {
      log.info("Feature cyber_security is off, skip...");
      return;
    }

    log.info("Start check domain alarm for:", remoteIP);
    const domain = await hostTool.getName(remoteIP);

    if (!domain) {
      return; // directly return if it's not a valid domain
    }

    log.info("Domain for IP ", remoteIP, "is", domain);

    let isDomain = false;
    try {
      isDomain = validator.isFQDN(domain);
    } catch (err) {
    }

    if (!isDomain) {
      log.info(`Domain '${domain}' is not a valid domain, skip check alarm:`);
      return;
    }

    let intelObj = null;
    try {
      log.info("Start to lookup intel for domain:", domain);
      intelObj = await intelManager.lookupDomain(domain, remoteIP, flowObj);
      log.info("Finish lookup intel for domain:", domain, "intel is", intelObj);
    } catch (err) {
      log.error("Error when lookup intel for domain:", domain, deviceIP, remoteIP, err);
      return;
    }

    if (!intelObj) {
      log.info("No intel for domain:", domain, deviceIP, remoteIP);
      return;
    }

    if (intelObj.severityscore && Number(intelObj.severityscore) === 0) {
      log.info("Intel ignored, severity score is zero", intelObj);
      return;
    }

    const reasons = []
    let _category, reason = 'Access a ';
    switch (intelObj.category) {
      case 'spam':
      case 'phishing':
      case 'piracy':
      case 'suspicious':
        reasons.push(intelObj.category)
        reason += intelObj.category;
        intelObj.severityscore = 30;
        _category = intelObj.category;
        break;
      case 'intel':
        reasons.push(intelObj.cc)
        reason += intelObj.cc;
        intelObj.severityscore = 70;
        _category = intelObj.cc;
        break;
      default:
        return;
    }

    reason += ' domain or host';
    let severity = intelObj.severityscore > 50 ? "major" : "minor";
    intelObj.reason = reason;
    intelObj.summary = '';

    log.info("Domain", domain, "'s intel is", intelObj);

    log.info("Start to generate alarm for domain", domain);

    const alarmPayload = {
      "p.device.ip": deviceIP,
      "p.device.port": this.getDevicePort(flowObj),
      "p.protocol": flowObj.pr || "tcp", // use tcp as default if no protocol given, no protocol is very unusual
      // "p.dest.id": remoteIP,
      "p.dest.ip": remoteIP,
      "p.dest.name": domain,
      "p.dest.port": this.getRemotePort(flowObj),
      "p.security.reason": reasons.join(","),
      "p.security.primaryReason": reasons[0],
      "p.security.numOfReportSources": "Firewalla global security intel",
      "p.local_is_client": (flowObj.fd === 'in' ? "1" : "0"),
      "p.source": "firewalla_intel",
      "p.severity.score": intelObj.severityscore,
      "r.dest.whois": JSON.stringify(intelObj.whois),
      "e.device.ports": this.getDevicePorts(flowObj),
      "e.dest.ports": this.getRemotePorts(flowObj),
      "p.from": intelObj.from,
      "p.intf.id": flowObj.intf,
      "p.tag.ids": flowObj.tags
    };

    if (flowObj.guid) {
      const identity = IdentityManager.getIdentityByGUID(flowObj.guid);
      if (identity)
        alarmPayload[identity.constructor.getKeyOfUIDInAlarm()] = identity.getUniqueId();
      alarmPayload["p.device.guid"] = flowObj.guid;
    }

    if (flowObj.rl)
      alarmPayload["p.device.real.ip"] = flowObj.rl;

    this.updateURLPart(alarmPayload, flowObj);

    let alarm = new Alarm.IntelAlarm(flowObj.ts, deviceIP, severity, alarmPayload);
    alarm['p.alarm.becauseof'] = intelObj.originIP;

    if (flowObj && flowObj.action && flowObj.action === "block") {
      alarm["p.action.block"] = true;
    }

    if (flowObj && flowObj.fd !== 'in' && flowObj.intel && flowObj.intel.category === 'intel' && Number(flowObj.intel.t) >= 10) {
      alarm["p.action.block"] = true;
    }

    alarm['p.security.category'] = [_category];
    alarm['p.alarm.trigger'] = 'domain';

    if (intelObj.tags) {
      alarm['p.security.tags'] = intelObj.tags;
    }

    log.info(`Cyber alarm for domain '${domain}' has been generated`, alarm);

    try {
      await alarmManager2.checkAndSaveAsync(alarm);
    } catch (err) {
      if (err.code === 'ERR_DUP_ALARM' || err.code === 'ERR_BLOCKED_BY_POLICY_ALREADY') {
        log.warn("Duplicated alarm exists or blocking policy already there, skip firing new alarm");
        return true; // in this case, ip alarm no need to trigger either
      }
      log.error("Error when save alarm:", err.message);
      return;
    }

    return true;
  }

  async checkIpAlarm(remoteIP, deviceIP, flowObj) {
    log.info("Check IP Alarm for traffic from: ", deviceIP, ", to:", remoteIP);
    const domain = await hostTool.getName(remoteIP);

    let iobj;
    try {
      iobj = await intelManager.lookupIp(remoteIP, flowObj.intel);
    } catch (err) {
      log.error("Host:Subscriber:Intel:NOTVERIFIED", deviceIP, remoteIP);
      return;
    }

    if (iobj.severityscore < 4) {
      log.error("Host:Subscriber:Intel:NOTSCORED", iobj);
      return;
    }

    let severity = iobj.severityscore > 50 ? "major" : "minor";
    const reason = (_.isArray(iobj.category) && iobj.category.join(",")) || "";
    const primaryReason = (_.isArray(iobj.category) && iobj.category.length > 0 && iobj.category[0]) || "";

    if (!fc.isFeatureOn("cyber_security")) {
      return;
    }

    const alarmPayload = {
      "p.device.ip": deviceIP,
      "p.device.port": this.getDevicePort(flowObj),
      "p.protocol": flowObj.pr || "tcp", // use tcp as default if no protocol given
      // "p.dest.id": remoteIP,
      "p.dest.ip": remoteIP,
      "p.dest.name": domain || remoteIP,
      "p.dest.port": this.getRemotePort(flowObj),
      "p.security.reason": reason,
      "p.security.primaryReason": primaryReason,
      "p.security.numOfReportSources": iobj.count,
      "p.local_is_client": (flowObj.fd === 'in' ? "1" : "0"),
      // "p.dest.whois": JSON.stringify(iobj.whois),
      "p.severity.score": iobj.severityscore,
      "p.from": iobj.from,
      "e.device.ports": this.getDevicePorts(flowObj),
      "e.dest.ports": this.getRemotePorts(flowObj),
      "p.intf.id": flowObj.intf,
      "p.tag.ids": flowObj.tags
    };

    if (flowObj.guid) {
      const identity = IdentityManager.getIdentityByGUID(flowObj.guid);
      if (identity)
        alarmPayload[identity.constructor.getKeyOfUIDInAlarm()] = identity.getUniqueId();
      alarmPayload["p.device.guid"] = flowObj.guid;
    }

    if (flowObj.rl)
      alarmPayload["p.device.real.ip"] = flowObj.rl;

    this.updateURLPart(alarmPayload, flowObj);

    let alarm = new Alarm.IntelAlarm(flowObj.ts, deviceIP, severity, alarmPayload);

    if (flowObj && flowObj.action && flowObj.action === "block") {
      alarm["p.action.block"] = true
    }

    if (flowObj && flowObj.fd !== 'in' && flowObj.intel && flowObj.intel.category === 'intel' && Number(flowObj.intel.t) >= 10) {
      alarm["p.action.block"] = true;
    }

    if (flowObj && flowObj.categoryArray) {
      alarm['p.security.category'] = flowObj.categoryArray;
    }

    if (iobj.tags) {
      alarm['p.security.tags'] = iobj.tags;
    }

    alarm['p.alarm.trigger'] = 'ip';

    log.info("Host:ProcessIntelFlow:Alarm", alarm);

    alarmManager2.enqueueAlarm(alarm)
  }
}
