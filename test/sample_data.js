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

exports.createSampleHost = () => {
  let addHost = hostTool.updateHost({
    ipv4Addr: "172.17.0.10",
    mac: "F4:0F:24:00:00:01",
    uid: "172.17.0.10",
    lastActiveTimestamp: new Date() / 1000 + "",
    firstFoundTimestamp: new Date() / 1000 + "",
    hostname: "Test Device 1",
    hostnameType: "PTR",
    macVendor: "Apple"
  });
  
  let addMac = hostTool.updateMACKey({
    bname: "Test Device 1",
    host: "Test Device 1",
    uid: "172.17.0.10",
    lastActiveTimestamp: new Date() / 1000 + "",
    firstFoundTimestamp: new Date() / 1000 + "",
    pname: "UnknownMobile/iOS",
    mac: "F4:0F:24:00:00:01",
    _name: "iPhone",
    ipv4Addr: "172.17.0.10",
    macVendor: "Apple",
    deviceClass: "mobile",
    ua_os_name: "iOS",
    ipv4: "172.17.0.10",
  });
  
  return Promise.all([addHost, addMac])
}

exports.removeSampleHost = () => {
  let removeHost = hostTool.deleteHost("172.17.0.10")
  let removeMac = hostTool.deleteMac("F4:0F:24:00:00:01")
  
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