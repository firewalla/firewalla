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

const rclient = require('../util/redis_manager.js').getRedisClient()

let Promise = require('bluebird');

const SysManager = require('./SysManager.js');
const sysManager = new SysManager('info');

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

let instance = null;

let maxV6Addr = 8;

var _async = require('async');

const iptool = require('ip');

const getPreferredBName = require('../util/util.js').getPreferredBName

class HostTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }

  macExists(mac) {
    return rclient.existsAsync("host:mac:" + mac)
      .then((result) => {
        return result == 1
      });
  }

  ipv4Exists(ip) {
    return rclient.existsAsync("host:ip4:" + ip)
      .then((result) => {
        return result == 1
      });
  }

  getIPv4Entry(ip) {
    if(!ip)
      return Promise.reject("invalid ip addr");

    let key = "host:ip4:" + ip;
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

  updateBackupName(mac, name) {
    log.info("Updating backup name", name, "for mac:", mac, {});
    let key = "host:mac:" + mac;
    return rclient.hsetAsync(key, "bname", name)
  }

  updateHost(host) {
    let uid = host.uid;
    let key = this.getHostKey(uid);

    let hostCopy = JSON.parse(JSON.stringify(host))
    
    if(hostCopy.ipv6Addr) {
      delete hostCopy.ipv6Addr
    }

    this.cleanupData(hostCopy);

    return rclient.hmsetAsync(key, hostCopy)
      .then(() => {
        return rclient.expireatAsync(key, parseInt((+new Date) / 1000) + 60 * 60 * 24 * 30); // auto expire after 30 days
      });
  }

  updateMACKey(host, skipUpdatingExpireTime) {

    let hostCopy = JSON.parse(JSON.stringify(host))

    if(hostCopy.mac && hostCopy.mac === "00:00:00:00:00:00") {
      log.error("Invalid MAC Address (00:00:00:00:00:00)", new Error().stack, {})
      //return Promise.reject(new Error("Invalid MAC Address (00:00:00:00:00:00)"));
      return // ignore 00:00:00:00:00:00
    }

    if(hostCopy.ipv6Addr && hostCopy.ipv6Addr.constructor.name === "Array") {
      hostCopy.ipv6Addr = JSON.stringify(hostCopy.ipv6Addr);
    }    
    
    this.cleanupData(hostCopy);

    let key = this.getMacKey(hostCopy.mac);
    return rclient.hmsetAsync(key, hostCopy)
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
      if(!macObject) {
        return ips
      }
      
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
      let host = null

      if (iptool.isV4Format(ip)) {
        host = await (this.getIPv4Entry(ip))        
      } else if(iptool.isV6Format(ip)) {
        host = await (this.getIPv6Entry(ip))
      } else {
        return null
      }

      return host && host.mac
    })();
  }

  getMacEntryByIP(ip) {
    return async(() => {
      const mac = await (this.getMacByIP(ip))
      return this.getMACEntry(mac)
    })()
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

  updateRecentActivity(mac, activity) {
    if(!activity || !mac) {
      // do nothing if activity or mac is null
      return Promise.resolve()
    }
    
    let key = this.getMacKey(mac)
    let string = JSON.stringify(activity)
    
    return rclient.hsetAsync(key, "recentActivity", string)
  }


  ////////////// IPV6 /////////////////////

  getIPv6Entry(ip) {
    if(!ip)
      return Promise.reject("invalid ip addr");
    
    let key = this.getIPv6HostKey(ip)
    return rclient.hgetallAsync(key);
  }
  
  getIPv6HostKey(ip) {
    let key = "host:ip6:" + ip;
    return key
  }

  ipv6Exists(ip) {
    let key = this.getIPv6HostKey(ip)
    return rclient.existsAsync(key)
      .then((result) => {
        return result == 1
      });
  }

  updateIPv6Host(host,ipv6Addr) {
    return async(() => {
      if(ipv6Addr && ipv6Addr.constructor.name === "Array") {
        ipv6Addr.forEach((addr) => {
          let key = this.getIPv6HostKey(addr)

          let existingData = await (rclient.hgetallAsync(key))
          let data = null
          
          if(existingData && existingData.mac === host.mac) {
            // just update last timestamp for existing device
            data = {
              lastActiveTimestamp: Date.now() / 1000
            }
          } else {
            data = {
              mac: host.mac,
              firstFoundTimestamp: Date.now() / 1000,
              lastActiveTimestamp: Date.now() / 1000
            }
          }

          await (rclient.hmsetAsync(key, data))
          await (rclient.expireatAsync(key, parseInt((+new Date) / 1000) + 60 * 60 * 24 * 4))
          
        })
      }
    })()   
  }

  ////////////////// END OF IPV6 ////////////////

  //pi@raspbNetworkScan:~/encipher.iot/net2 $ ip -6 neighbor show
  //2601:646:a380:5511:9912:25e1:f991:4cb2 dev eth0 lladdr 00:0c:29:f4:1a:e3 STALE
  // 2601:646:a380:5511:9912:25e1:f991:4cb2 dev eth0 lladdr 00:0c:29:f4:1a:e3 STALE
  // 2601:646:a380:5511:385f:66ff:fe7a:79f0 dev eth0 lladdr 3a:5f:66:7a:79:f0 router STALE
  // 2601:646:9100:74e0:8849:1ba4:352d:919f dev eth0  FAILED  (there are two spaces between eth0 and Failed)

  /* 
   * ipv6 differs from ipv4, which it will randomly generate IP addresses, and use them
   * in very short term.  It is pretty hard to detect how long these will be used, so 
   * we just hard code max number of ipv6 address
   * 
   * we will use 8 for now
   */

  ipv6Insert(ipv6array,v6addr,unspoof,callback) {
      let removed = ipv6array.splice(maxV6Addr,1000);
      log.info("V6 Overflow Check: ", ipv6array, v6addr);
      if (v6addr) {
          let oldindex = ipv6array.indexOf(v6addr);
          if (oldindex != -1) {
             ipv6array.splice(oldindex,1);
          }
          ipv6array.unshift(v6addr);
      }
      log.info("V6 Overflow Check Removed: ", removed,{});
 
      if (unspoof && removed && removed.length>0) {
          _async.eachLimit(removed, 10, (ip6, cb) => {
              rclient.srem("monitored_hosts6", ip6,(err)=>{
                  log.info("V6 Overflow Removed for real", ip6,err,{});
                  cb();
              });
          }, (err) => {
              callback(removed);
          });
      } else {
          callback(null);
      }
  }

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
          rclient.expireat(v6key, parseInt((+new Date) / 1000) + 604800); // 7 days
          rclient.hgetall(mackey, (err, data) => {
            log.info("============== Discovery:v6Neighbor:Scan:mac", v6key, mac, mackey, data);
            if (err == null) {
              if (data != null) {
                let ipv6array = [];
                if (data.ipv6Addr) {
                  ipv6array = JSON.parse(data.ipv6Addr);
                }

                // only keep around 5 ipv6 around
                /*
                ipv6array = ipv6array.slice(0,8)
                let oldindex = ipv6array.indexOf(v6addr);
                if (oldindex != -1) {
                  ipv6array.splice(oldindex,1);
                }
                ipv6array.unshift(v6addr);
                */
                this.ipv6Insert(ipv6array,v6addr,true,(removed)=>{
                  data.mac = mac.toUpperCase();
                  data.ipv6Addr = JSON.stringify(ipv6array);
                  data.lastActiveTimestamp = Date.now() / 1000;
                  log.info("HostTool:Writing Data:", mackey, data,{});
                  rclient.hmset(mackey, data, (err, result) => {
                    callback(err, null);
                  });
                });
                //v6 at times will discver neighbors that not there ...
                //so we don't update last active here
                //data.lastActiveTimestamp = Date.now() / 1000;
              } else {
                data = {};
                data.mac = mac.toUpperCase();
                data.ipv6Addr = JSON.stringify([v6addr]);;
                data.lastActiveTimestamp = Date.now() / 1000;
                data.firstFoundTimestamp = data.lastActiveTimestamp;
                log.info("HostTool:Writing Data:", mackey, data,{});
                rclient.hmset(mackey, data, (err, result) => {
                  callback(err, null);
                });
              }
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

  getIPv6AddressesByMAC(mac) {
    return async(() => {
      let key = this.getMacKey(mac)
      let v6String = await (rclient.hgetAsync(key, "ipv6Addr"))
      if(!v6String) {
        return []
      }
      
      try {
        let v6Addrs = JSON.parse(v6String)
        return v6Addrs
      } catch(err) {
        log.error(`Failed to parse v6 addrs: ${v6String}`)
        return []
      }
    })()
  }

  isMacAddress(mac) {
    const macAddressPattern =  /^([0-9a-fA-F][0-9a-fA-F]:){5}([0-9a-fA-F][0-9a-fA-F])$/
    return macAddressPattern.test(mac)
  }

  getName(ip) {
    return async(() => {
      if(sysManager.isLocalIP(ip)) {
        const macEntry = await (this.getMacEntryByIP(ip))
        return getPreferredBName(macEntry)
      } else {
        const intelEntry = await (intelTool.getIntel(ip))
        return intelEntry && intelEntry.host
      }
    })()
  }

  filterOldDevices(hostList) {
    const validHosts = hostList.filter(host => host.mac != null)
    const activeHosts = {}
    for (const index in validHosts) {
      const host = validHosts[index]
      const ip = host.ipv4Addr
      if(!ip) {
        continue
      }

      if(!activeHosts[ip]) {
        activeHosts[ip] = host
      } else {
        const existingHost = activeHosts[ip]

        // new one is newer
        if(parseFloat(existingHost.lastActiveTimestamp) < parseFloat(host.lastActiveTimestamp)) {
          activeHosts[ip] = host
        }
      }      
    }

    return Object.values(activeHosts).map(h => h.mac).filter((mac, index, array) => array.indexOf(mac) == index)
  }
}

module.exports = HostTool;
