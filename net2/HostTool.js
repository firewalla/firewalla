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

let log = require('./logger.js')(__filename);

let redis = require('redis');
let rclient = redis.createClient();

let Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

let SysManager = require('./SysManager.js');
let sysManager = new SysManager('info');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let instance = null;
class HostTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }

  macExists(mac) {
    return rclient.keysAsync("host:mac:" + mac)
      .then((results) => {
        return results.length > 0;
      });
  }

  ipv4Exists(ip) {
    return rclient.keysAsync("host:ip4:" + ip)
      .then((results) => {
        return results.length > 0;
      });
  }

  getIPv4Entry(ip) {
    if(!ip)
      return Promise.reject("invalid ip addr");

    let key = "host:ip4:" + ip;
    return rclient.hgetallAsync(key);
  }

  getIPv6Entry(ip) {
    if(!ip)
      return Promise.reject("invalid ip addr");

    let key = "host:ip6:" + ip;
    return rclient.hgetallAsync(key);
  }

  getMACEntry(mac) {
    if(!mac)
      return Promise.reject("invalid mac address");

    return rclient.hgetallAsync(this.getMacKey(mac));
  }

  getHostname(hostEntry) {
    if(hostEntry.name)
      return hostEntry.name;

    if(hostEntry.bname && hostEntry.bname !== "_")
      return hostEntry.bname;

    if(hostEntry.sambaName && hostEntry.sambaName !== "_")
      return hostEntry.sambaName;

    return hostEntry.ipv4;
  }

  ipv6Exists(ip) {
    return rclient.keysAsync("host:ip6:" + ip)
      .then((results) => {
        return results.length > 0;
      });
  }

  updateBackupName(mac, name) {
    log.info("Updating backup name", name, "for mac:", mac, {});
    let key = "host:mac:" + mac;
    return rclient.hsetAsync(key, "bname", name)
  }

  updateHost(host) {
    let uid = host.uid;
    let key = this.getHostKey(uid);
    if(host.ipv6Addr && host.ipv6Addr.constructor.name === "Array") {
      host.ipv6Addr = JSON.stringify(host.ipv6Addr);
    }

    this.cleanupData(host);

    return rclient.hmsetAsync(key, host)
      .then(() => {
        return rclient.expireatAsync(key, parseInt((+new Date) / 1000) + 60 * 60 * 24 * 30); // auto expire after 30 days
      });
  }

  updateMACKey(host, skipUpdatingExpireTime) {
   
    if(host.mac && host.mac === "00:00:00:00:00:00") {
      log.error("Invalid MAC Address (00:00:00:00:00:00)", new Error().stack, {})
      return Promise.reject(new Error("Invalid MAC Address (00:00:00:00:00:00)"));
    }

    if(host.ipv6Addr && host.ipv6Addr.constructor.name === "Array") {
      host.ipv6Addr = JSON.stringify(host.ipv6Addr);
    }    
    
    this.cleanupData(host);

    let key = this.getMacKey(host.mac);
    return rclient.hmsetAsync(key, host)
      .then(() => {
        if(skipUpdatingExpireTime) {
          return;
        } else {
          return rclient.expireatAsync(key, parseInt((+new Date) / 1000) + 60 * 60 * 24 * 365); // auto expire after 365 days
        }
      })
  }

  updateKeysInMAC(mac, hash) {
    let key = this.getMacKey(mac);

    return rclient.hmsetAsync(key, hash);
  }


  getHostKey(ipv4) {
    return "host:ip4:" + ipv4;
  }

  cleanupData(data) {
    Object.keys(data).forEach((key) => {
      if(data[key] == undefined) {
        delete data[key];
      }
    })
  }

  deleteHost(ipv4) {
    return rclient.delAsync(this.getHostKey(ipv4));
  }

  getMacKey(mac) {
    return "host:mac:" + mac;
  }
  deleteMac(mac) {
    return rclient.delAsync(this.getMacKey(mac));
  }

  mergeHosts(oldhost, newhost) {
    let changeset = {};
    for (let i in oldhost) {
      if (newhost[i] != null) {
        if (oldhost[i] != newhost[i]) {
          changeset[i] = newhost[i];
        }
      }
    }
    for (let i in newhost) {
      if (oldhost[i] == null) {
        changeset[i] = newhost[i];
      }
    }
    return changeset;
  }

  getIPsByMac(mac) {
    return async(() => {
      let ips = [];
      let macObject = await(this.getMACEntry(mac));
      if(macObject.ipv4Addr) {
        ips.push(macObject.ipv4Addr);
      }

      if(macObject.ipv6Addr) {
        let json = macObject.ipv6Addr;
        let ipv6s = JSON.parse(json);
        ips.push.apply(ips, ipv6s);
      }

      return ips;
    })();
  }

  getMacByIP(ip) {
    return async(() => {
      let host = await (this.getIPv4Entry(ip));
      return host && host.mac;
    })();
  }

  getAllMACs() {
    return async(() => {
      let keys = await (rclient.keysAsync("host:mac:*"));
      return keys.map((key) => key.replace("host:mac:", ""));
    })();
  }

  getAllMACEntries() {
    return async(() => {
      let macKeys = await (this.getAllMACs());
      let entries = [];
      macKeys.forEach((mac) => {
        let entry = await (this.getMACEntry(mac));
        entries.push(entry);
      })
      return entries;
    })();
  }

  getAllIPs() {
    let allIPs = [];

    return async(() => {

      let macs = await (this.getAllMACs());

      macs.forEach((mac) => {
        let ips = await (this.getIPsByMac(mac));
        if(ips) {
          allIPs.push({ips: ips, mac: mac})
        }
      });

      return allIPs;
    })();
  }

  //pi@raspbNetworkScan:~/encipher.iot/net2 $ ip -6 neighbor show
  //2601:646:a380:5511:9912:25e1:f991:4cb2 dev eth0 lladdr 00:0c:29:f4:1a:e3 STALE
  // 2601:646:a380:5511:9912:25e1:f991:4cb2 dev eth0 lladdr 00:0c:29:f4:1a:e3 STALE
  // 2601:646:a380:5511:385f:66ff:fe7a:79f0 dev eth0 lladdr 3a:5f:66:7a:79:f0 router STALE
  // 2601:646:9100:74e0:8849:1ba4:352d:919f dev eth0  FAILED  (there are two spaces between eth0 and Failed)


  linkMacWithIPv6(v6addr, mac, callback) {
    require('child_process').exec("ping6 -c 3 -I eth0 "+v6addr, (err, out, code) => {
    });
    log.info("Discovery:AddV6Host:", v6addr, mac);
    mac = mac.toUpperCase();
    let v6key = "host:ip6:" + v6addr;
    log.debug("============== Discovery:v6Neighbor:Scan", v6key, mac);
    sysManager.setNeighbor(v6addr);
    rclient.hgetall(v6key, (err, data) => {
      log.debug("-------- Discover:v6Neighbor:Scan:Find", mac, v6addr, data, err);
      if (err == null) {
        if (data != null) {
          data.mac = mac;
          data.lastActiveTimestamp = Date.now() / 1000;
        } else {
          data = {};
          data.mac = mac;
          data.lastActiveTimestamp = Date.now() / 1000;
          data.firstFoundTimestamp = data.lastActiveTimestamp;
        }
        rclient.hmset(v6key, data, (err, result) => {
          log.debug("++++++ Discover:v6Neighbor:Scan:find", err, result);
          let mackey = "host:mac:" + mac;
          rclient.expireat(v6key, parseInt((+new Date) / 1000) + 2592000);
          rclient.hgetall(mackey, (err, data) => {
            log.debug("============== Discovery:v6Neighbor:Scan:mac", v6key, mac, mackey, data);
            if (err == null) {
              if (data != null) {
                let ipv6array = [];
                if (data.ipv6) {
                  ipv6array = JSON.parse(data.ipv6);
                }

                // only keep around 5 ipv6 around
                ipv6array = ipv6array.slice(0,8)
                let oldindex = ipv6array.indexOf(v6addr);
                if (oldindex != -1) {
                  ipv6array.splice(oldindex,1);
                }
                ipv6array.unshift(v6addr);

                data.mac = mac.toUpperCase();
                data.ipv6 = JSON.stringify(ipv6array);
                data.ipv6Addr = JSON.stringify(ipv6array);
                //v6 at times will discver neighbors that not there ...
                //so we don't update last active here
                //data.lastActiveTimestamp = Date.now() / 1000;
              } else {
                data = {};
                data.mac = mac.toUpperCase();
                data.ipv6 = JSON.stringify([v6addr]);;
                data.ipv6Addr = JSON.stringify([v6addr]);;
                data.lastActiveTimestamp = Date.now() / 1000;
                data.firstFoundTimestamp = data.lastActiveTimestamp;
              }
              log.debug("Wring Data:", mackey, data);
              rclient.hmset(mackey, data, (err, result) => {
                callback(err, null);
              });
            } else {
              log.error("Discover:v6Neighbor:Scan:Find:Error", err);
              callback(null, null);
            }
          });

        });
      } else {
        log.error("!!!!!!!!!!! Discover:v6Neighbor:Scan:Find:Error", err);
        callback(null, null);
      }
    });
  }
}

module.exports = HostTool;
