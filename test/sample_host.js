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



let Promise = require('bluebird');

function createSampleHost() {
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

function removeSampleHost() {
  let removeHost = hostTool.deleteHost("172.17.0.10")
  let removeMac = hostTool.deleteMac("F4:0F:24:00:00:01")
  
  return Promise.all([removeHost, removeMac])
}

module.exports = {
  createSampleHost: createSampleHost,
  removeSampleHost: removeSampleHost
}