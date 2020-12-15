/*    Copyright 2016 Firewalla LLC
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

let HostTool = require('../net2/HostTool')
let hostTool = new HostTool();
const DNSTool = require('../net2/DNSTool.js');
const dnsTool = new DNSTool();

let Alarm = require('../alarm/Alarm.js');
let Exception = require('../alarm/Exception.js');
let ExceptionManager = require('../alarm/ExceptionManager.js');
let exceptionManager = new ExceptionManager();
let AlarmManager2 = require('../alarm/AlarmManager2.js')
let alarmManager2 = new AlarmManager2();
let Promise = require('bluebird');

let redis = require('redis');
let rclient = redis.createClient();

let flowTool = require('../net2/FlowTool')();

let FlowAggrTool = require('../net2/FlowAggrTool');
let flowAggrTool = new FlowAggrTool();

Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

let ts = Math.floor(new Date() / 1000);
let now = Math.floor(new Date() / 1000);

let hostIP = "172.17.0.10";
let hostMac = "F4:0F:24:00:00:01";
let hostIP2 = "172.17.0.20";
let hostMac2 = "F4:0F:24:00:00:02";
let destIP = "114.113.217.103";
let destIP2 = "114.113.217.104";

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

exports.createSampleException= () => {
  return new Promise((resolve, reject) => {
    let e1 = new Exception({"p.dest.name": "spotify.com"});
    exceptionManager.saveException(e1, (err) => {
      if(err) {
        reject(err);
        return;
      }

      lastExceptionID = e1.eid;

      resolve();
    })
  })
}

exports.removeSampleException = () => {
  if(lastExceptionID) {
    return exceptionManager.deleteException(lastExceptionID)
  }

  return Promise.resolve();
};

exports.createSamplePolicy = () => {

}

exports.createSampleVideoAlarm = () => {
  let a1 = new Alarm.VideoAlarm(new Date() / 1000, "10.0.1.22", "DEST-1", {
    "p.dest.name": "spotify.com",
    "p.device.name": "My Macbook",
    "p.device.id": "My Macbook",
    "p.dest.id": "spotify.com"
  });
  return alarmManager2.checkAndSaveAsync(a1);
};

exports.createSampleGameAlarm = () => {
  let a1 = new Alarm.GameAlarm(new Date() / 1000, "10.0.1.199", "battle.net", {
    device: "MiMac",
    alarmTimestamp: "1500906094.763",
    timestamp: "1500906041.064573",
    notifType: "activity",
    "p.dest.ip": destIP,
    "p.dest.name": "battle.net",
    "p.device.ip" : "10.0.1.199",
    "p.device.name": "MiMac",
    "p.device.id": "B8:09:8A:B9:4B:05",
    "p.dest.id": "battle.net",
    "p.device.macVendor": "Apple",
    "p.device.mac": "B8:09:8A:B9:4B:05",
    "p.dest.latitude": "31.0456",
    "p.dest.longitude": "121.3997",
    "p.dest.country": "CN",
    message: "This device visited game website battle.net."
  });
  return alarmManager2.checkAndSaveAsync(a1);
};

exports.createSampleException2 = () => {
  return new Promise((resolve, reject) => {
    let e1 = new Exception({
      "i.type": "domain",
      "reason": "ALARM_GAME",
      "type": "ALARM_GAME",
      "timestamp": "1500913117.175",
      "p.dest.id": "battle.net",
      "target_name": "battle.net",
      "target_ip": destIP,
    });

    exceptionManager.saveException(e1, (err) => {
      if(err) {
        reject(err);
        return;
      }

      lastExceptionID = e1.eid;

      resolve();
    })
  });
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
    keys.forEach((key) => {
      await rclient.delAsync(key);
    })
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

    ips.forEach((ip) => {
      let key = "intel:ip:" + ip;
      await rclient.hmsetAsync(key, {
        ip: ip,
        host: "www.google.com",
        country: "US",
        app: "search",
        apps: '{"search": "100"}'
      });
    });
  })();
}

exports.removeSampleIntelInfo = () => {
  let ips = [destIP, destIP2];

  return (async() =>{
    ips.forEach((ip) => {
      let key = "intel:ip:" + ip;
      await rclient.delAsync(key);
    });
  })();
}

exports.sampleLicense = require('./sample_license.json');
