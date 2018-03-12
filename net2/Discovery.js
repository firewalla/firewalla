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
var ip = require('ip');
var os = require('os');
var dns = require('dns');
var network = require('network');
var linux = require('../util/linux.js');
var Nmap = require('./Nmap.js');
var instances = {};


let sem = require('../sensor/SensorEventManager.js').getInstance();

let l2 = require('../util/Layer2.js');

const rclient = require('../util/redis_manager.js').getRedisClient()

var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');


let Alarm = require('../alarm/Alarm.js');
let AM2 = require('../alarm/AlarmManager2.js');
let am2 = new AM2();

let async = require('async');

let HostTool = require('../net2/HostTool.js');
let hostTool = new HostTool();

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
  constructor(name, config, loglevel, noScan) {
        if (instances[name] == null) {

          if(config == null) {
            config = require('./config.js').getConfig();
          }
          
          this.hosts = [];
          this.name = name;
          this.config = config;
          
          instances[name] = this;

          let p = require('./MessageBus.js');
          this.publisher = new p(loglevel);

          if(!noScan || noScan === false) {
            this.publisher.subscribe("DiscoveryEvent", "Host:Detected", null, (channel, type, ip, obj) => {
                if (type == "Host:Detected") {
                    log.info("Dynamic scanning found over Host:Detected", ip);
                    this.scan(ip, true, (err, result) => {});
                }
            });
          }

          this.hostCache = {};
        }
    
        return instances[name];
  }

  startDiscover(fast, callback) {
        callback = callback || function() {}

        this.discoverInterfaces((err, list) => {
          log.info("Discovery::Scan", this.config.discovery.networkInterfaces, {});
          for (let i in this.config.discovery.networkInterfaces) {

                let intf = this.interfaces[this.config.discovery.networkInterfaces[i]];
                if (intf != null) {
                  log.debug("Prepare to scan subnet", intf, {});
                    if (this.nmap == null) {
                        this.nmap = new Nmap(intf.subnet,false);
                    }
                    this.scan(intf.subnet, fast, (err, result) => {
                      this.neighborDiscoveryV6(intf.name,intf);
                      callback();
                    });
                }
            }
        });
  }
  
  discoverMac(mac, callback) {
    callback = callback || function() {}

    this.discoverInterfaces((err, list) => {
      log.info("Discovery::DiscoverMAC", this.config.discovery.networkInterfaces, {});
      let found = null;
      async.eachLimit(this.config.discovery.networkInterfaces, 1, (name, cb) => {
        let intf = this.interfaces[name];
        if (intf == null) {
          cb();
          return;
        }
        if (found) {
          cb();
          return;
        }
        if (intf != null) {
          log.debug("Prepare to scan subnet", intf, {});
          if (this.nmap == null) {
            this.nmap = new Nmap(intf.subnet,false);
          }
          
          log.info("Start scanning network ", intf.subnet, "to look for mac", mac, {});
          
          this.nmap.scan(intf.subnet, true, (err, hosts, ports) => {
            if(err) {
              log.error("Failed to scan: " + err);
              cb();
              return;
            }
            
            this.hosts = [];

            for (let i in hosts) {
              let host = hosts[i];
              if(host.mac && host.mac === mac) {
                found = host;
                cb();
                return;
              }
            }
            cb();
          });
        }
      }, (err)=>{
        log.info("Discovery::DiscoveryMAC:Found", found);
        if (found) {
          callback(null, found); 
        } else {
          this.getAndSaveArpTable((err,arpList,arpTable)=>{ 
            log.info("discoverMac:miss", mac);
            if (arpTable[mac]) {
              log.info("discoverMac:found via ARP", arpTable[mac]);
              callback(null, arpTable[mac]);
            } else{
              callback(null, null);
            }
          });
        }
      });
    });
  }   

  getAndSaveArpTable(cb) {
    let fs = require('fs');
    try {
      fs.readFile('/proc/net/arp', (err, data)=> {
        let cols, i, lines;
        let arpList = []; 
        this.arpTable = {};
      
        if (err) return cb(err, arpList,this.arpTable);
        lines = data.toString().split('\n');
        for (i = 0; i < lines.length; i++) {
          if (i === 0) continue;
          cols = lines[i].replace(/ [ ]*/g, ' ').split(' ');
          if ((cols.length > 3) && (cols[0].length !== 0) && (cols[3].length !== 0)) {
            let now=Date.now()/1000;
            let mac = cols[3].toUpperCase();
            let ipv4 = cols[0];
            let arpData = {ipv4Addr: cols[0], mac: mac, uid:ipv4, lastActiveTimestamp:now, firstFoundTimestamp:now};
            arpList.push(arpData);
            this.arpTable[mac] = arpData;
          }
        }
        cb(null, arpList,this.arpTable);
      });
    } catch(e){
      log.error("getAndArpTable Exception: ",e,null);
      cb(null,[],{});
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

    is_interface_valid(netif) {
        return netif.ip_address != null && netif.mac_address != null && netif.type != null && !netif.ip_address.startsWith("169.254.");
    }

    discoverInterfaces(callback) {
        this.interfaces = {};
        linux.get_network_interfaces_list((err,list)=>{
     //   network.get_interfaces_list((err, list) => {
//            log.info("Found list of interfaces", list, {});
            let redisobjs = ['sys:network:info'];
            if (list == null || list.length <= 0) {
                log.error("Discovery::Interfaces", "No interfaces found");
		if(callback) {
			callback(null, []);
		}
                return;
            }

	    // ignore any invalid interfaces
            let self = this;

          list.forEach((i) => {
            log.info("Found interface %s %s", i.name, i.ip_address);
          });
          
	    list = list.filter(function(x) { return self.is_interface_valid(x) });

            for (let i in list) {
                log.debug(list[i], {});

                redisobjs.push(list[i].name);
                list[i].gateway = require('netroute').getGateway(list[i].name);
                list[i].subnet = this.getSubnet(list[i].name, 'IPv4');
                list[i].gateway6 = linux.gateway_ip6_sync();
                if (list[i].subnet.length > 0) {
                    list[i].subnet = list[i].subnet[0];
                }
                list[i].dns = dns.getServers();
                this.interfaces[list[i].name] = list[i];
                redisobjs.push(JSON.stringify(list[i]));

                // "{\"name\":\"eth0\",\"ip_address\":\"192.168.2.225\",\"mac_address\":\"b8:27:eb:bd:54:da\",\"type\":\"Wired\",\"gateway\":\"192.168.2.1\",\"subnet\":\"192.168.2.0/24\"}"
                if (list[i].type=="Wired" && list[i].name!="eth0:0") {
                    let host = {
                        name:"Firewalla",
                        uid:list[i].ip_address,
                        mac:list[i].mac_address.toUpperCase(),
                        ipv4Addr:list[i].ip_address,
                        ipv6Addr:list[i].ip6_addresses || JSON.stringify([]),
                    };
                    this.processHost(host);
                }
            }
            /*
            let interfaces = os.interfaces();
            for (let i in interfaces) {
               for (let z in interfaces[i]) {
                   let interface = interfaces[i];
               }
            }
            */
          log.debug("Setting redis", redisobjs, {});

            rclient.hmset(redisobjs, (error, result) => {
                if (error) {
                    log.error("Discovery::Interfaces:Error", redisobjs,list,error);
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


  scan(subnet, fast, callback) {
    if(this.nmap == null) {
      log.error("nmap object is null when trying to scan");
      callback(null, null);
      return;
    }
        log.info("Start scanning network:",subnet,fast);
        this.publisher.publish("DiscoveryEvent", "Scan:Start", '0', {});
    this.nmap.scan(subnet, fast, (err, hosts, ports) => {
      if(err) {
        log.error("Failed to scan: " + err);
        return;
      }
            this.hosts = [];
            for (let h in hosts) {
                let host = hosts[h];
                this.processHost(host);
            }
            //log.info("Done Processing ++++++++++++++++++++");
            log.info("Network scanning is completed:",subnet,hosts.length);
            setTimeout(() => {
                callback(null, null);
                log.info("Discovery:Scan:Done");
                this.publisher.publish("DiscoveryEvent", "Scan:Done", '0', {});
                sysManager.setOperationalState("LastScan", Date.now() / 1000);
            }, 2000);
        });
    }

    /* host.uid = ip4 adress
       host.mac = mac address
       host.ipv4Addr 
    */

    // mac ip changed, need to wipe out the old 
    
    ipChanged(mac,ip,newmac,callback) {
       let key = "host:mac:" + mac.toUpperCase();;
       log.info("Discovery:Mac:Scan:IpChanged", key, ip,newmac);
       rclient.hgetall(key, (err, data) => {
          log.info("Discovery:Mac:Scan:IpChanged2", key, ip,newmac,JSON.stringify(data));
          if (err == null && data.ipv4 == ip) {
              rclient.hdel(key,'name');
              rclient.hdel(key,'bname');
              rclient.hdel(key,'ipv4');
              rclient.hdel(key,'ipv4Addr');
              rclient.hdel(key,'host');
              log.info("Discovery:Mac:Scan:IpChanged3", key, ip,newmac,JSON.stringify(data));
          }
          if (callback) {
              callback(err,null);
          }
       });
    }

    // FIXME: not every routine this callback may be called.
    processHost(host, callback) {
      callback = callback || function() {}
      
      if (host.mac == null) {
        log.debug("Discovery:Nmap:HostMacNull:", host);
        callback(null, null);
        return;
      }

      let nname = host.nname;

      let key = "host:ip4:" + host.uid;
      log.info("Discovery:Nmap:Scan:Found", key, host.mac, host.uid,host.ipv4Addr,host.name,host.nname);
      rclient.hgetall(key, (err, data) => {
        log.debug("Discovery:Nmap:Redis:Search", key, data, {});
        if (err == null) {
          if (data != null) {
            let changeset = hostTool.mergeHosts(data, host);
            changeset['lastActiveTimestamp'] = Math.floor(Date.now() / 1000);
            if(data.firstFoundTimestamp != null) {
              changeset['firstFoundTimestamp'] = data.firstFoundTimestamp;
            } else {
              changeset['firstFoundTimestamp'] = changeset['lastActiveTimestamp'];
            }
            changeset['mac'] = host.mac;
            log.debug("Discovery:Nmap:Redis:Merge", key, changeset, {});
            if (data.mac!=null && data.mac!=host.mac) {
              this.ipChanged(data.mac,host.uid,host.mac);
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
                //this.publisher.publish("DiscoveryEvent", "Host:Found", "0", host);
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
              if (data.bname == null && nname!=null) {
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
            rclient.expireat(key, parseInt((+new Date) / 1000) + 60*60*24*365);
            rclient.hmset(key, data, (err, result) => {
              if (err!=null) {
                log.error("Failed update ", key,err,result);
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

    //pi@raspbNetworkScan:~/encipher.iot/net2 $ ip -6 neighbor show
    //2601:646:a380:5511:9912:25e1:f991:4cb2 dev eth0 lladdr 00:0c:29:f4:1a:e3 STALE
    // 2601:646:a380:5511:9912:25e1:f991:4cb2 dev eth0 lladdr 00:0c:29:f4:1a:e3 STALE
    // 2601:646:a380:5511:385f:66ff:fe7a:79f0 dev eth0 lladdr 3a:5f:66:7a:79:f0 router STALE
    // 2601:646:9100:74e0:8849:1ba4:352d:919f dev eth0  FAILED  (there are two spaces between eth0 and Failed)

    addV6Host(v6addr, mac, callback) {
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

    ping6ForDiscovery(intf,obj,callback) {
        this.process = require('child_process').exec("ping6 -c2 -I eth0 ff02::1", (err, out, code) => {
            async.eachLimit(obj.ip6_addresses, 5, (o, cb) => {
               let pcmd = "ping6 -B -c 2 -I eth0 -I "+o+"  ff02::1";
               log.info("Discovery:v6Neighbor:Ping6",pcmd);
               require('child_process').exec(pcmd,(err)=>{
                  cb();
               }); 
            }, (err)=>{
                callback(err); 
            }); 
        });
    }

    neighborDiscoveryV6(intf,obj) {
        if (obj.ip6_addresses==null || obj.ip6_addresses.length<=1) {
            log.info("Discovery:v6Neighbor:NoV6",intf,obj);
            return;
        }
        this.ping6ForDiscovery(intf,obj,(err) => {
            let cmdline = 'ip -6 neighbor show';
            log.info("Running commandline: ", cmdline);

            this.process = require('child_process').exec(cmdline, (err, out, code) => {
                let lines = out.split("\n");
                async.eachLimit(lines, 1, (o, cb) => {
                    log.info("Discover:v6Neighbor:Scan:Line", o, "of interface", intf);
                    let parts = o.split(" ");
                    if (parts[2] == intf) {
                        let v6addr = parts[0];
                        let mac = parts[4].toUpperCase();
                        if (mac == "FAILED" || mac.length < 16) {
                            cb();
                        } else {
                            this.addV6Host(v6addr, mac, (err) => {
                                cb();
                            });
                        }
                    } else {
                        cb();
                    }
                }, (err) => {});
            });
        });

    }

    fetchHosts(callback) {
        this.DB.sync();
        this.DB.Host.DBModel.findAll().then((objs) => {
            callback(null, objs);
        });
    }
    fetchPorts(callback) {
        this.DB.sync();
        this.DB.Port.DBModel.findAll().then((objs) => {
            callback(null, objs);
        });
    }

    getSubnet(networkInterface, family) {
        this.networkInterfaces = os.networkInterfaces();
        let interfaceData = this.networkInterfaces[networkInterface];
        if (interfaceData == null) {
            return null;
        }

        var ipSubnets = [];


        for (let i = 0; i < interfaceData.length; i++) {
            if (interfaceData[i].family == family && interfaceData[i].internal == false) {
                let subnet = ip.subnet(interfaceData[i].address, interfaceData[i].netmask);
                let subnetmask = subnet.networkAddress + "/" + subnet.subnetMaskLength;
                ipSubnets.push(subnetmask);
            }
        }

        return ipSubnets;

    }
}
