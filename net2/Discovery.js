/*    Copyright 2016-2019 Firewalla Inc.
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
const log = require('./logger.js')(__filename);
const Nmap = require('./Nmap.js');
var instances = {};

const sem = require('../sensor/SensorEventManager.js').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()
const pclient = require('../util/redis_manager.js').getPublishClient();

const sysManager = require('./SysManager.js');

const networkTool = require('./NetworkTool.js')();
const platform = require('../platform/PlatformLoader.js').getPlatform();

const util = require('util');

const Config = require('./config.js');
const firerouter = require('./FireRouter.js');

const uuid = require('uuid')
const _ = require('lodash')
const Message = require('./Message.js');

/*
 *   config.discovery.networkInterfaces : list of interfaces
 */
/*
 *   sys::network::info = {
 *         'eth0': {
               subnet:
               gateway:
            }
 *         "wlan0': {
               subnet:
               gateway:
            }
 *
 */

/* Host structure
    "name": == bonjour name, can be over written by user
    "bname": bonjour name
    'addresses': [...]
    'host': host field in bonjour
 1) "ipv4Addr"
 3) "mac"
 5) "uid"
 7) "lastActiveTimestamp"
 9) "firstFoundTimestamp"
11) "macVendor"

..

*/

module.exports = class {
  constructor(name, config, loglevel) {
    if (instances[name] == null) {

      if (config == null) {
        config = Config.getConfig();
      }

      this.hosts = [];
      this.name = name;
      this.config = config;

      instances[name] = this;

      let p = require('./MessageBus.js');
      this.publisher = new p(loglevel);

      this.hostCache = {};
    }

    return instances[name];
  }

  async discoverMac(mac) {
    const list = sysManager.getMonitoringInterfaces();
    let found = null;
    for (const intf of list) {
      if (intf == null) {
        continue;
      }
      if (found) {
        break;
      }
      if (intf != null && intf.name && intf.name !== "tun_fwvpn" && !intf.name.startsWith("wg")) {
        log.debug("Prepare to scan subnet", intf);
        if (this.nmap == null) {
          this.nmap = new Nmap(intf.subnet, false);
        }

        log.info("Start scanning network ", intf.subnet, "to look for mac", mac);

        // intf.subnet is in v4 CIDR notation
        try {
          let hosts = await this.nmap.scanAsync(intf.subnet, true)

          this.hosts = [];

          for (let i in hosts) {
            let host = hosts[i];
            if (host.mac && host.mac === mac) {
              found = host;
              break;
            }
          }
        } catch (err) {
          log.error("Failed to scan: " + err);
          continue
        }
      }
    }
    log.info("Discovery::DiscoveryMAC:Found", found);
    if (found) {
      return found;
    } else {
      const arpTable = await util.promisify(this.getAndSaveArpTable).bind(this)();
      log.info("discoverMac:miss", mac);
      if (arpTable[mac]) {
        log.info("discoverMac:found via ARP", arpTable[mac]);
        return arpTable[mac];
      } else {
        return null;
      }
    }
  }

  getAndSaveArpTable(cb) {
    let fs = require('fs');
    try {
      fs.readFile('/proc/net/arp', (err, data) => {
        let cols, i, lines;
        this.arpTable = {};

        if (err) return cb(err, this.arpTable);
        lines = data.toString().split('\n');
        for (i = 0; i < lines.length; i++) {
          if (i === 0) continue;
          cols = lines[i].replace(/ [ ]*/g, ' ').split(' ');
          if ((cols.length > 3) && (cols[0].length !== 0) && (cols[3].length !== 0)) {
            let now = Date.now() / 1000;
            let mac = cols[3].toUpperCase();
            let ipv4 = cols[0];
            let arpData = { ipv4Addr: cols[0], mac: mac, uid: ipv4, lastActiveTimestamp: now, firstFoundTimestamp: now };
            this.arpTable[mac] = arpData;
          }
        }
        cb(null, this.arpTable);
      });
    } catch (e) {
      log.error("getAndArpTable Exception: ", e, null);
      cb(null, {});
    }
  }

  /**
   * Only call release function when the SysManager instance is no longer
   * needed
   */
  release() {
    rclient.quit();
    sysManager.release();
    log.debug("Calling release function of Discovery");
  }

  discoverInterfaces(callback = () => {}) {
    this.discoverInterfacesAsync()
      .then(list => callback(null, list))
      .catch(err => callback(err))
  }

  async discoverInterfacesAsync(publishUpdate = true) {
    this.interfaces = {};
    let list = [];
    if (!platform.isFireRouterManaged())
      list = await networkTool.listInterfaces();
    else {
      // firerouter.init should return quickly
      await firerouter.init();
      list = await firerouter.getSysNetworkInfo();
    }
    if (!list.length) {
      log.warn('No interface')
      return list;
    }

    // add consistent uuid to interfaces
    if (!platform.isFireRouterManaged()) {
      const uuidIntf = await rclient.hgetallAsync('sys:network:uuid');
      for (const intf of list) {
        let uuidAssigned = _.findKey(uuidIntf, i => {
          try {
            const obj = JSON.parse(i);
            return obj.name == intf.name
          } catch (err) {}
          return false;
        });
        if (!uuidAssigned) {
          uuidAssigned = uuid.v4()
          intf.uuid = uuidAssigned
          log.warn(`Interface uuid not assigned! Assigning ${uuidAssigned} to ${intf.name}`)
          await rclient.hsetAsync('sys:network:uuid', uuidAssigned, JSON.stringify(intf))
        } else {
          intf.uuid = uuidAssigned
        }
      }
    }

    let redisobjs = ['sys:network:info'];
    for (const intf of list) {
      redisobjs.push(intf.name);
      redisobjs.push(JSON.stringify(intf));

      /*
      {
        "name":"eth0",
        "ip_address":"192.168.2.225",
        "mac_address":"b8:27:eb:bd:54:da",
        "conn_type":"Wired",
        "gateway":"192.168.2.1",
        "subnet":"192.168.2.0/24",
        "type": "wan"
      }
      */
      if (intf.conn_type == "Wired" && !intf.name.endsWith(':0')) {
        sem.emitEvent({
          type: "DeviceUpdate",
          message: "Firewalla self discovery",
          suppressAlarm: true,
          host: {
            name: "Firewalla",
            uid: intf.ip_address,
            mac: intf.mac_address.toUpperCase(),
            ipv4Addr: intf.ip_address,
            ipv6Addr: intf.ip6_addresses || [],
            macVendor: "Firewalla",
            from: "Discovery"
          },
          toProcess: 'FireMain'
        })
      }
    }

    log.debug("Setting redis", redisobjs);

    try {
      const result = await rclient.hmsetAsync(redisobjs)
      log.debug("Discovery::Interfaces", result.length);
    } catch (error) {
      log.error("Discovery::Interfaces:Error", redisobjs, list, error);
    }
    if (publishUpdate)
      await pclient.publishAsync(Message.MSG_SYS_NETWORK_INFO_UPDATED, "");
    return list
  }

}
