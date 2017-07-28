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

let Alarm = require('../alarm/Alarm.js');
let Exception = require('../alarm/Exception.js');
let ExceptionManager = require('../alarm/ExceptionManager.js');
let exceptionManager = new ExceptionManager();
let AlarmManager2 = require('../alarm/AlarmManager2.js')
let alarmManager2 = new AlarmManager2();
let Promise = require('bluebird');

let redis = require('redis');
let rclient = redis.createClient();

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let flowTool = require('../net2/FlowTool')();

let FlowAggrTool = require('../net2/FlowAggrTool');
let flowAggrTool = new FlowAggrTool();

Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

let ts = Math.floor(new Date() / 1000);
let now = Math.floor(new Date() / 1000);

let hostIP = "172.17.0.10";
let hostMac = "F4:0F:24:00:00:01";
let destIP = "114.113.217.103";

exports.ts = ts;
exports.now = now;
exports.hostIP = hostIP;
exports.hostMac = hostMac;
exports.destIP = destIP;

exports.createSampleHost = () => {
  let addHost = hostTool.updateHost({
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
  
  return Promise.all([addHost, addMac])
}

exports.removeSampleHost = () => {
  let removeHost = hostTool.deleteHost(hostIP)
  let removeMac = hostTool.deleteMac(hostMac)
  
  return Promise.all([removeHost, removeMac])
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
  "bl":900,
  "pf":{"udp.8000":{"ob":262,"rb":270,"ct":1}},
  "af":{},
  "pr":"tcp",
  "f":null,
  "flows":[[1500975078,1500975078,262,270]]};


let flowObj2 = {
  "ts": ts + 1,
  "_ts": ts + 1,
  "__ts": ts + 1,
  "sh":hostIP,
  "dh": destIP,
  "ob":100,
  "rb":200,
  "ct":1,
  "fd":"in", // download
  "lh":hostIP,
  "du":100,
  "bl":900,
  "pf":{"udp.8000":{"ob":262,"rb":270,"ct":1}},
  "af":{},
  "pr":"tcp",
  "f":null,
  "flows":[[1500975078,1500975078,262,270]]};

exports.sampleFlow1 = flowObj;
exports.sampleFlow2 = flowObj2;
  
exports.createSampleFlows = () => {
  return async(() => {
    await (flowTool.addFlow(hostIP, "in", flowObj));
    await (flowTool.addFlow(hostIP, "in", flowObj2));
  })();
};

exports.removeSampleFlows = () => {
  return async(() => {
    await (flowTool.removeFlow(hostIP, "in", flowObj));
    await (flowTool.removeFlow(hostIP, "in", flowObj2));
  })();
};

exports.createSampleAggrFlows = () => {
  return async(() => {
    await (flowAggrTool.addFlow(hostMac, "download", 600, flowAggrTool.getIntervalTick(ts, 600), destIP, 200));
    await (flowAggrTool.addFlow(hostMac, "download", 600, flowAggrTool.getIntervalTick(ts, 600) - 600, destIP, 300));
  })();  
}

exports.removeSampleAggrFlows = () => {
  return async(() => {
    await (flowAggrTool.removeFlow(hostMac, "download", "600", now, destIP));
  })();
};

exports.removeAllSampleAggrFlows = () => {
  return async(() => {
    let keys = await(rclient.keysAsync("aggrflow:F4:0F:24:00:00:01:*"));
    keys.forEach((key) => {
      await (rclient.delAsync(key));
    })
  })();
};

exports.addSampleSSLInfo = () => {
  return async(() => {
    let key = "host:ext.x509:" + hostIP;
    
    let data = {
      "server_name": "www.google.com",
      "subject": "CN=*.google.com,OU=COMODO SSL Wildcard,OU=ABCDEF"
    };
    
    return rclient.hmsetAsync(key, data);
  })();
}

exports.removeSampleSSLInfo = () => {
  return async(() => {
    let key = "host:ext.x509:" + hostIP;

    return rclient.delAsync(key);
  })();
}

exports.addSampleDNSInfo = () => {
  return async(() => {
    let key = "dns:ip:" + hostIP;

    let data = {
      host: 'www.google.com',
      lastActive: '1501220422',
      count: '24',
      _intel: '{"ts":1500896988,"rcount":2}'
    };

    return rclient.hmsetAsync(key, data);
  })();
}

exports.removeSampleDNSInfo = () => {
  return async(() => {
    let key = "dns:ip:" + hostIP;

    return rclient.delAsync(key);
  })();
}