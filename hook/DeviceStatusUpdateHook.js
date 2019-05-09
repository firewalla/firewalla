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

let log = require('../net2/logger.js')(__filename, 'info');

let Hook = require('./Hook.js');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let HostTool = require('../net2/HostTool.js');
let hostTool = new HostTool();

let async = require('async');

let Promise = require('bluebird');

class DeviceStatusUpdateHook extends Hook {
  constructor() {
    super();
  }
  
  run() {
    sem.on("DeviceStatusUpdate", (event) => {
      let host = event.host;
      if(!host)
        return;
      
      this.updateIPv6entries(host.ipv6Addrs, (err) => { // ignore err
        hostTool.getIPv4Entry(host.ipv4Addr)
          .then((oldHost) => {
            let mergedHost = hostTool.mergeHosts(oldHost, host);
            console.log("mergedHost", mergedHost, {});
            hostTool.updateIPv4Host(mergedHost)
              .then(() => {
              log.info("Updated host info for device ", mergedHost.bname, "(", mergedHost.ipv4, ")");
              }).catch((err) => {
              log.error("Failed to updateIPv4Host: ", err);
            })
          })
      })
    });
  }
  
  updateIPv6entries(ipv6Addrs, callback) {
    if(!ipv6Addrs || ipv6Addrs.length == 0) {
      callback(null);
      return;
    }

    // update link between ipv6 and mac
    async.eachLimit(ipv6Addrs, 1, (v6addr, cb) => {
      this.hostTool.linkMacWithIPv6(v6addr, mac, (err) => {
        cb(err);
      });
    }, callback);
  }
}

module.exports = DeviceStatusUpdateHook
