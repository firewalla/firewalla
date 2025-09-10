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
'use strict';

const HostTool = require('../net2/HostTool')
const hostTool = new HostTool();
const DNSTool = require('../net2/DNSTool.js');
const dnsTool = new DNSTool();

const Alarm = require('../alarm/Alarm.js');
const Exception = require('../alarm/Exception.js');
const ExceptionManager = require('../alarm/ExceptionManager.js');
const exceptionManager = new ExceptionManager();
const AlarmManager2 = require('../alarm/AlarmManager2.js')
const alarmManager2 = new AlarmManager2();
const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();

const rclient = require('../util/redis_manager').getRedisClient();

const flowTool = require('../net2/FlowTool');

const FlowAggrTool = require('../net2/FlowAggrTool');
const flowAggrTool = new FlowAggrTool();

const ts = Math.floor(new Date() / 1000);
const now = Math.floor(new Date() / 1000);

const hostIP = "172.17.0.10";
const hostMac = "F4:0F:24:00:00:01";
const hostIP2 = "172.17.0.20";
const hostMac2 = "F4:0F:24:00:00:02";
const destIP = "114.113.217.103";
const destIP2 = "114.113.217.104";

exports.ts = ts;
exports.now = now;
exports.hostIP = hostIP;
exports.hostMac = hostMac;
exports.hostIP2 = hostIP2;
exports.hostMac2 = hostMac2;
exports.destIP = destIP;
exports.destIP2 = destIP2;

exports.newDeviceHost = {
  mac: hostMac,
  ipv4Addr: hostIP,
  ipv4: hostIP
}

exports.createSampleHost = () => {
  let addHost = hostTool.updateIPv4Host({
    ipv4Addr: hostIP,
    mac: hostMac,
    uid: hostIP,
    lastActiveTimestamp: new Date() / 1000 + "",
    firstFoundTimestamp: new Date() / 1000 + "",
    hostname: "Test Device 1",
    hostnameType: "PTR",
    macVendor: "Apple"
  });

  let addMac = hostTool.updateMACKey({
    bname: "Test Device 1",
    host: "Test Device 1",
    uid: hostIP,
    lastActiveTimestamp: new Date() / 1000 + "",
    firstFoundTimestamp: new Date() / 1000 + "",
    pname: "UnknownMobile/iOS",
    mac: hostMac,
    _name: "iPhone",
    ipv4Addr: hostIP,
    macVendor: "Apple",
    deviceClass: "mobile",
    ua_os_name: "iOS",
    ipv4: hostIP,
    ipv6Addr: "[\"fe80::aa07:d334:59a3:1200\", \"fe80::aa07:d334:59a3:1201\"]"
  });

  let addHost2 = hostTool.updateIPv4Host({
    ipv4Addr: hostIP,
    mac: hostMac2,
    uid: hostIP2,
    lastActiveTimestamp: new Date() / 1000 + "",
    firstFoundTimestamp: new Date() / 1000 + "",
    hostname: "Test Device 2",
    hostnameType: "PTR",
    macVendor: "Apple"
  });

  let addMac2 = hostTool.updateMACKey({
    bname: "Test Device 2",
    host: "Test Device 2",
    uid: hostIP2,
    lastActiveTimestamp: new Date() / 1000 + "",
    firstFoundTimestamp: new Date() / 1000 + "",
    pname: "UnknownMobile/iOS",
    mac: hostMac2,
    _name: "iPhone",
    ipv4Addr: hostIP2,
    macVendor: "Apple",
    deviceClass: "mobile",
    ua_os_name: "iOS",
    ipv4: hostIP,
    ipv6Addr: "[\"fe80::aa07:d334:59a3:1202\", \"fe80::aa07:d334:59a3:1203\"]"
  });

  return Promise.all([addHost, addMac, addHost2, addMac2])
}

exports.removeSampleHost = () => {
  let removeHost = hostTool.deleteHost(hostIP)
  let removeMac = hostTool.deleteMac(hostMac)
  let removeHost2 = hostTool.deleteHost(hostIP2)
  let removeMac2 = hostTool.deleteMac(hostMac2)

  return Promise.all([removeHost, removeMac, removeHost2, removeMac2])
}

let lastExceptionID = null;

exports.createSampleException= async () => {
  let e1 = new Exception({"p.dest.name": "spotify.com"});
  await exceptionManager.saveExceptionAsync(e1)
  lastExceptionID = e1.eid;
  return e1
}

exports.removeSampleException = async () => {
  if(lastExceptionID) {
    return exceptionManager.deleteException(lastExceptionID)
  }

  return Promise.resolve();
};

exports.createSamplePolicy = () => {

}

exports.createSampleVideoAlarm = async () => {
  const hosts = await hostManager.getHostsAsync()
  if (!hosts || !hosts.length) {
    throw new Error("No host found");
  }
  const a1 = new Alarm.VideoAlarm(new Date() / 1000, hosts[0].getReadableName(), "spotify.com", {
    "p.device.name": hosts[0].getReadableName(),
    "p.device.id": hosts[0].getGUID(),
    "p.device.mac": hosts[0].getGUID(),
  });
  return alarmManager2.checkAndSaveAsync(a1);
};

exports.createSampleGameAlarm = async () => {
  const hosts = await hostManager.getHostsAsync()
  if (!hosts || !hosts.length) {
    throw new Error("No host found");
  }
  let a1 = new Alarm.GameAlarm(new Date() / 1000, hosts[0].getReadableName(), "battle.net", {
    notifType: "activity",
    "p.dest.ip": destIP,
    "p.device.name": hosts[0].getReadableName(),
    "p.device.id": hosts[0].getGUID(),
    "p.device.mac": hosts[0].getGUID(),
    message: "This device visited game website battle.net."
  });
  return alarmManager2.checkAndSaveAsync(a1);
};

exports.createSampleException2 = async () => {
  let e2 = new Exception({
    "i.type": "domain",
    "reason": "ALARM_GAME",
    "type": "ALARM_GAME",
    "timestamp": "1500913117.175",
    "p.dest.id": "battle.net",
    "target_name": "battle.net",
    "target_ip": destIP,
  });

  await exceptionManager.saveExceptionAsync(e2)

  lastExceptionID = e2.eid;

  return e2
};

let flowObj = {
  "ts": ts,
  "_ts": ts,
  "__ts": ts,
  "sh":hostIP,
  "dh": destIP,
  "ob":100,
  "rb":200,
  "ct":1,
  "fd":"in", // download
  "lh":hostIP,
  "du":100,
  "pf":{"udp.8000":{"ob":262,"rb":270,"ct":1}},
  "af":{},
  "pr":"tcp",
  "f":null,
  "flows":[[1500975078,1500975078,262,270]]};


let flowObj2 = {
  "ts": ts - 10,
  "_ts": ts - 10,
  "__ts": ts - 10,
  "sh":hostIP,
  "dh": destIP,
  "ob":100,
  "rb":200,
  "ct":1,
  "fd":"in", // download
  "lh":hostIP,
  "du":300,
  "pf":{"udp.8000":{"ob":262,"rb":270,"ct":1}},
  "af":{},
  "pr":"tcp",
  "f":null,
  "flows":[[1500975078,1500975078,262,270]]};

let flowObj3 = JSON.parse(JSON.stringify(flowObj));
flowObj3.dh = destIP2;
flowObj3.ob = 300;
flowObj3.rb = 400;
flowObj3.fd = 'out';

let flowObj4 = JSON.parse(JSON.stringify(flowObj2));
flowObj4.dh = destIP2;
flowObj4.ob = 300;
flowObj4.rb = 400;
flowObj4.fd = 'out';

exports.sampleFlow1 = flowObj;
exports.sampleFlow2 = flowObj2;
exports.sampleFlow3 = flowObj3;
exports.sampleFlow4 = flowObj4;

exports.createSampleFlows = () => {
  return (async() =>{
    await flowTool.addFlow(hostIP, "in", flowObj);
    await flowTool.addFlow(hostIP, "in", flowObj2);
    await flowTool.addFlow(hostIP, "out", flowObj3);
    await flowTool.addFlow(hostIP, "out", flowObj4);
  })();
};

exports.removeSampleFlows = () => {
  return (async() =>{
    await flowTool.removeFlow(hostIP, "in", flowObj);
    await flowTool.removeFlow(hostIP, "in", flowObj2);
    await flowTool.removeFlow(hostIP, "out", flowObj3);
    await flowTool.removeFlow(hostIP, "out", flowObj4);
  })();
};

exports.createSampleAggrFlows = () => {
  return (async() =>{
    await flowAggrTool.addFlow(hostMac, "download", 600, flowAggrTool.getIntervalTick(ts, 600), destIP, 200);
    await flowAggrTool.addFlow(hostMac, "download", 600, flowAggrTool.getIntervalTick(ts, 600) - 600, destIP, 300);
  })();
}

exports.removeSampleAggrFlows = () => {
  return (async() =>{
    await flowAggrTool.removeFlow(hostMac, "download", "600", now, destIP);
  })();
};

exports.removeAllSampleAggrFlows = () => {
  return (async() =>{
    let keys = await rclient.keysAsync("aggrflow:F4:0F:24:00:00:01:*");
    await Promise.all(keys.map(async (key) => {
      await rclient.delAsync(key);
    }));
  })();
};

exports.addSampleSSLInfo = () => {
  return (async() =>{
    let key = "host:ext.x509:" + hostIP;

    let data = {
      "server_name": "www.google.com",
      "subject": "CN=*.google.com,OU=COMODO SSL Wildcard,OU=ABCDEF"
    };

    return rclient.hmsetAsync(key, data);
  })();
}

exports.removeSampleSSLInfo = () => {
  return (async() =>{
    let key = "host:ext.x509:" + hostIP;

    return rclient.delAsync(key);
  })();
}

exports.addSampleDNSInfo = () => {
  return (async() =>{
    await dnsTool.addDns(hostIP, "www.google.com");
  })();
}

exports.removeSampleDNSInfo = () => {
  return (async() =>{
    await dnsTool.removeDns(hostIP, "www.google.com");
  })();
}

exports.addSampleIntelInfo = () => {
  return (async() =>{
    let ips = [destIP, destIP2];
    await Promise.all(ips.map(async (ip) => {
      let key = "intel:ip:" + ip;
      await rclient.hmsetAsync(key, {
        ip: ip,
        host: "www.google.com",
        country: "US",
        app: "search",
        apps: '{"search": "100"}'
      });
    }));
  })();
}

exports.removeSampleIntelInfo = () => {
  let ips = [destIP, destIP2];

  return (async() =>{
    await Promise.all(ips.map(async (ip) => {
      let key = "intel:ip:" + ip;
      await rclient.delAsync(key);
    }));
  })();
}

// exports.sampleLicense = require('./sample_license.json');
