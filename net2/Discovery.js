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
const log = require('./logger.js')(__filename);
const Nmap = require('./Nmap.js');
var instances = {};

const sem = require('../sensor/SensorEventManager.js').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()

const SysManager = require('./SysManager.js');
const sysManager = new SysManager('info');

const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

const networkTool = require('./NetworkTool.js')();
const util = require('util');

const Config = require('./config.js');

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
        config = require('./config.js').getConfig();
      }

      this.hosts = [];
      this.name = name;
      this.config = config;

      instances[name] = this;

      let p = require('./MessageBus.js');
      this.publisher = new p(loglevel);

      this.hostCache = {};

      this.discoverInterfacesAsync = util.promisify(this.discoverInterfaces)
    }

    return instances[name];
  }

  async discoverMac(mac) {
    await this.discoverInterfacesAsync()
    log.info("Discovery::DiscoverMAC", this.config.discovery.networkInterfaces);
    let found = null;
    for (const name of this.config.discovery.networkInterfaces) {
      let intf = this.interfaces[name];
      if (intf == null) {
        continue;
      }
      if (found) {
        break;
      }
      if (intf != null) {
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

  start() {
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

  discoverInterfaces(callback) {
    this.interfaces = {};
    const config = Config.getConfig(true);
    networkTool.listInterfaces().then(list => {
      let redisobjs = ['sys:network:info'];
      for (let i in list) {
        log.debug(list[i]);

        redisobjs.push(list[i].name);
        this.interfaces[list[i].name] = list[i];
        redisobjs.push(JSON.stringify(list[i]));

        /*
        {
          "name":"eth0",
          "ip_address":"192.168.2.225",
          "mac_address":"b8:27:eb:bd:54:da",
          "type":"Wired",
          "gateway":"192.168.2.1",
          "subnet":"192.168.2.0/24"
        }
        */
        if (list[i].type == "Wired" && list[i].name != config.monitoringInterface2) {
          let host = {
            name: "Firewalla",
            uid: list[i].ip_address,
            mac: list[i].mac_address.toUpperCase(),
            ipv4Addr: list[i].ip_address,
            ipv6Addr: list[i].ip6_addresses || JSON.stringify([]),
            macVendor:"Firewalla"
          };
          this.processHost(host);
        }
      }

      log.debug("Setting redis", redisobjs);

      rclient.hmset(redisobjs, (error, result) => {
        if (error) {
          log.error("Discovery::Interfaces:Error", redisobjs, list, error);
        } else {
          log.debug("Discovery::Interfaces", error, result.length);
        }
        if (callback) {
          callback(null, list);
        }
      });
    });
  }

  filterByVendor(_vendor) {
    let foundHosts = [];
    for (let h in this.hosts) {
      let vendor = this.hosts[h].macVendor;
      if (vendor != null) {
        if (vendor.toLowerCase().indexOf(_vendor.toLowerCase()) >= 0) {
          foundHosts.push(this.hosts[h]);
        }
      }
    }
    return foundHosts;
  }


  /* host.uid = ip4 adress
     host.mac = mac address
     host.ipv4Addr
  */

  // mac ip changed, need to wipe out the old

  ipChanged(mac, ip, newmac, callback) {
    let key = "host:mac:" + mac.toUpperCase();;
    log.info("Discovery:Mac:Scan:IpChanged", key, ip, newmac);
    rclient.hgetall(key, (err, data) => {
      log.info("Discovery:Mac:Scan:IpChanged2", key, ip, newmac, JSON.stringify(data));
      if (err == null && data && data.ipv4 == ip) {
        rclient.hdel(key, 'name');
        rclient.hdel(key, 'bname');
        rclient.hdel(key, 'ipv4');
        rclient.hdel(key, 'ipv4Addr');
        rclient.hdel(key, 'host');
        log.info("Discovery:Mac:Scan:IpChanged3", key, ip, newmac, JSON.stringify(data));
      }
      if (callback) {
        callback(err, null);
      }
    });
  }

  // FIXME: not every routine this callback may be called.
  processHost(host, callback) {
    callback = callback || function () { }

    if (host.mac == null) {
      log.debug("Discovery:Nmap:HostMacNull:", host);
      callback(null, null);
      return;
    }

    let nname = host.nname;

    let key = "host:ip4:" + host.uid;
    log.info("Discovery:Nmap:Scan:Found", key, host.mac, host.uid, host.ipv4Addr, host.name, host.nname);
    rclient.hgetall(key, (err, data) => {
      log.debug("Discovery:Nmap:Redis:Search", key, data);
      if (err == null) {
        if (data != null) {
          let changeset = hostTool.mergeHosts(data, host);
          changeset['lastActiveTimestamp'] = Math.floor(Date.now() / 1000);
          if (data.firstFoundTimestamp != null) {
            changeset['firstFoundTimestamp'] = data.firstFoundTimestamp;
          } else {
            changeset['firstFoundTimestamp'] = changeset['lastActiveTimestamp'];
          }
          changeset['mac'] = host.mac;
          log.debug("Discovery:Nmap:Redis:Merge", key, changeset);
          if (data.mac != null && data.mac != host.mac) {
            this.ipChanged(data.mac, host.uid, host.mac);
          }
          rclient.hmset(key, changeset, (err, result) => {
            if (err) {
              log.error("Discovery:Nmap:Update:Error", err);
            } else {
              rclient.expireat(key, parseInt((+new Date) / 1000) + 2592000);
            }
          });
          // old mac based on this ip does not match the mac
          // tell the old mac, that it should have the new ip, if not change it
        } else {
          log.info("A new host is found: " + host.uid);

          let c = this.hostCache[host.uid];
          if (c && Date.now() / 1000 < c.expires) {
            host.name = c.name;
            host.bname = c.name;
            log.debug("Discovery:Nmap:HostCache:Look", c);
          }
          rclient.hmset(key, host, (err, result) => {
            if (err) {
              log.error("Discovery:Nmap:Create:Error", err);
            } else {
              rclient.expireat(key, parseInt((+new Date) / 1000) + 2592000);
            }
          });
        }
      } else {
        log.error("Discovery:Nmap:Redis:Error", err);
      }
    });
    if (host.mac != null) {
      let key = "host:mac:" + host.mac.toUpperCase();;
      let newhost = false;
      rclient.hgetall(key, (err, data) => {
        if (err == null) {
          if (data != null) {
            data.ipv4 = host.ipv4Addr;
            data.ipv4Addr = host.ipv4Addr;
            data.lastActiveTimestamp = Date.now() / 1000;
            data.mac = host.mac.toUpperCase();
            if (host.macVendor) {
              data.macVendor = host.macVendor;
            }
            if (data.bname == null && nname != null) {
              data.bname = nname;
            }
            //log.info("Discovery:Nmap:Update",key, data);
          } else {
            data = {};
            data.ipv4 = host.ipv4Addr;
            data.ipv4Addr = host.ipv4Addr;
            data.lastActiveTimestamp = Date.now() / 1000;
            data.firstFoundTimestamp = data.lastActiveTimestamp;
            data.mac = host.mac.toUpperCase();
            if (host.macVendor) {
              data.macVendor = host.macVendor;
            }
            newhost = true;
            if (host.name) {
              data.bname = host.name;
            }
            if (nname) {
              data.bname = nname;
            }
            let c = this.hostCache[host.uid];
            if (c && Date.now() / 1000 < c.expires) {
              data.name = c.name;
              data.bname = c.name;
              log.debug("Discovery:Nmap:HostCache:LookMac", c);
            }
          }
          rclient.expireat(key, parseInt((+new Date) / 1000) + 60 * 60 * 24 * 365);
          rclient.hmset(key, data, (err, result) => {
            if (err != null) {
              log.error("Failed update ", key, err, result);
              return;
            }
            if (newhost == true) {
              callback(null, host, true);

              sem.emitEvent({
                type: "NewDevice",
                name: data.name || data.bname || host.name,
                ipv4Addr: data.ipv4Addr,
                mac: data.mac,
                macVendor: data.macVendor,
                message: "new device event by process host"
              });
            }
          });
        } else {

        }
      });
    }
  }
}
