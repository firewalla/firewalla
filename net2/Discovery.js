/*    Copyright 2016 Rottiesoft LLC 
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
var log;
var ip = require('ip');
var os = require('os');
var network = require('network');
var Nmap = require('./Nmap.js');
var instances = {};
var bonjour = require('bonjour')();

var redis = require("redis");
var rclient = redis.createClient();

rclient.on("error", function (err) {
    console.log("Redis(alarm) Error " + err);
});

var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');

var AlarmManager = require('./AlarmManager.js');
var alarmManager = new AlarmManager('debug');

var async = require('async');

var natUpnp = require('nat-upnp');


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
            log = require("./logger.js")("discovery", loglevel);

            this.hosts = [];
            this.name = name;
            this.config = config;
            //  this.networks = this.getSubnet(networkInterface,family);
//            console.log("Scanning Address:", this.networks);
            instances[name] = this;
            let p = require('./MessageBus.js');
            this.publisher = new p(loglevel);
            //this.scan((err,response)=> {
            //});
            this.publisher.subscribe("DiscoveryEvent", "Host:Detected", null, (channel, type, ip, obj) => {
                if (type == "Host:Detected") {
                    log.info("Dynamic scanning found over Host:Detected", ip);
                    this.scan(ip, true, (err, result) => {});
                }
            });

            this.upnpClient = natUpnp.createClient();

            this.hostCache = {};

        }
        return instances[name];
    }

    startDiscover(fast) {
        this.discoverInterfaces((err, list) => {
            log.debug("Discovery::Scan", this.config.discovery.networkInterfaces, list);
            for (let i in this.config.discovery.networkInterfaces) {
                let intf = this.interfaces[this.config.discovery.networkInterfaces[i]];
                if (intf != null) {
                    log.debug("Prepare to scan subnet", intf);
                    if (this.nmap == null) {
                        this.nmap = new Nmap(intf.subnet);
                    }
                    this.scan(intf.subnet, fast, (err, result) => {
                        this.bonjourWatch();
                        this.neighborDiscoveryV6(intf.name);
                    });
                }
            }
        });
    }

    start() {
        this.startDiscover(true);
        setTimeout(() => {
            this.startDiscover(false);
        }, 1000 * 60 * 10);
        setInterval(() => {
            this.startDiscover(false);
        }, 1000 * 60 * 100);
        setInterval(() => {
            this.startDiscover(true);
        }, 1000 * 60 * 5);
        this.natScan();
    }

    /**
     * Only call release function when the SysManager instance is no longer
     * needed
     */
    release() {
        rclient.quit();
        alarmManager.release();
        sysManager.release();
        bonjour.destroy();
        log.debug("Calling release function of Discovery");
    }
    
    natScan() {
        setInterval(() => {
            this.upnpClient.getMappings(function (err, results) {
                if (results && results.length >= 0) {
                    let key = "sys:scan:nat";
                    rclient.hmset(key, {
                        upnp: JSON.stringify(results)
                    }, (err, data) => {
                        log.info("Discover:NatScan", results);
                    });
                }
            });
        }, 60000);
    }

    bonjourParse(service) {
        log.info("Discover:Bonjour:Parsing:Received", service, {});
        if (service == null) {
            return;
        }
        if (service.addresses == null || service.addresses.length == 0 || service.referer.address == null) {
            return;
        }



        let ipv4addr = null;
        let ipv6addr = [];

        for (let i in service.addresses) {
            let addr = service.addresses[i];
            if (ip.isV4Format(addr) && sysManager.isLocalIP(addr)) {
                ipv4addr = addr;
            } else if (ip.isV4Format(addr)) {
                log.info("Discover:Bonjour:Parsing:NotLocakV4Adress", addr);
                continue;
            } else if (ip.isV6Format(addr)) {
                ipv6addr.push(addr);
            }

        }


        if (ipv4addr == null) {
            //     ipv4addr = service.referer.address;
        }

        log.info("Discover:Bonjour:Parsing:Parsing", ipv4addr, ipv6addr, service, {});


        // Future need to scan software as well ... the adverisement from bonsjour also say something about ssh ...

        if (ipv4addr) {
            this.findHostWithIP(ipv4addr, (key, err, data) => {
                let now = Date.now() / 1000;
                let name = service.host.replace(".local", "");
                if (name.length <= 1) {
                    name = service.name;
                }

                if (key == null) {
                    //    key = "host:ip4:"+ipv4addr;
                    if (name != null) {
                        this.hostCache[ipv4addr] = {
                            'name': name,
                            'expires': now + 60 * 5
                        };
                        log.debug("Discovery:Nmap:HostCache:Insert", this.hostCache[ipv4addr]);
                    }
                    log.error("Discover:Bonjour:Parsing:NotFound:", ipv4addr, service);
                    return;
                }

                let host = {
                    uid: ipv4addr,
                    ipv4Addr: ipv4addr,
                    ipv4: ipv4addr,
                    lastActiveTimestamp: now,
                    firstFoundTimestamp: now,
                    bname: name,
                    host: service.host
                };
                if (ipv6addr.length > 0) {
                    host.ipv6Addr = JSON.stringify(ipv6addr);
                }


                async.eachLimit(ipv6addr, 1, (o, cb) => {
                    if (data != null) {
                        this.addV6Host(o, data.mac, (err, data) => {
                            cb();
                        });
                    } else {
                        cb();
                    }
                }, (err) => {
                    log.debug("Discovery:Bonjour:Redis:Search", key, data, {});
                    if (err == null) {
                        if (data != null) {
                            let changeset = this.mergeHosts(data, host);
                            changeset['lastActiveTimestamp'] = Date.now() / 1000;
                            changeset['firstFoundTimestamp'] = data.firstFoundTimestamp;
                            log.info("Discovery:Bonjour:Redis:Merge", key, changeset, {});
                            rclient.hmset(key, changeset, (err, result) => {
                                if (err) {
                                    log.error("Discovery:Nmap:Update:Error", err);
                                }
                            });
                        } else {
                            rclient.hmset(key, host, (err, result) => {
                                if (err) {
                                    log.error("Discovery:Nmap:Create:Error", err);
                                } else {
                                    this.publisher.publish("DiscoveryEvent", "Host:Found", "0", host);
                                    let d = JSON.parse(JSON.stringify(host));
                                    let actionobj = {
                                         title: "New Host",
                                         actions: ["hblock","ignore"],
                                         target: host.ipv4Addr,
                                    }
                                    alarmManager.alarm(host.ipv4Addr, "newhost", 'major', '50', d, actionobj, null);
                                }
                            });
                        }
                    } else {
                        log.error("Discovery:Nmap:Redis:Error", err);
                    }
                });

            });
        }
    }

    bonjourWatch() {
        log.info("Bonjour Watch Starting");
        if (this.bonjourBrowserTcp == null) {
            this.bonjourBrowserTcp = bonjour.find({
                protocol: 'tcp'
            }, (service) => {
                this.bonjourParse(service);
            });
            this.bonjourBrowserUdp = bonjour.find({
                protocol: 'udp'
            }, (service) => {
                this.bonjourParse(service);
            });
            this.bonjourTimer = setInterval(() => {
                log.info("Bonjour Watch Updating");
                this.bonjourBrowserTcp.update();
                this.bonjourBrowserUdp.update();
            }, 1000 * 60 * 5);
        }

        this.bonjourBrowserTcp.stop();
        this.bonjourBrowserUdp.stop();

        this.bonjourTimer = setInterval(() => {
            this.bonjourBrowserTcp.start();
            this.bonjourBrowserUdp.start();
        }, 1000 * 5);

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

    discoverInterfaces(callback) {
        this.interfaces = {};
        network.get_interfaces_list((err, list) => {
            log.debug("Found list of interfaces", list, {});
            let redisobjs = ['sys:network:info'];
            if (list == null || list.length <= 0) {
                log.error("Discovery::Interfaces", "No interfaces found");
		if(callback) {
			callback(null, []);
		}
                return;
            }

            // ignore 169.254.x.x
            list = list.filter(function(x) { return !x.ip_address.startsWith("169.254.") });
            
            for (let i in list) {
                log.debug(list[i], {});

                redisobjs.push(list[i].name);
                list[i].gateway = require('netroute').getGateway(list[i].name);
                list[i].subnet = this.getSubnet(list[i].name, 'IPv4');
                if (list[i].subnet.length > 0) {
                    list[i].subnet = list[i].subnet[0];
                }
                this.interfaces[list[i].name] = list[i];
                redisobjs.push(JSON.stringify(list[i]));
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
                    log.error("Discovery::Interfaces:Error", error);
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

    findHostWithIP(ip, callback) {
        let key = "host:ip4:" + ip;
        log.debug("Discovery:FindHostWithIP", key, ip);
        rclient.hgetall(key, (err, data) => {
            if (data == null) {
                callback(null, null, null);
                return;
            }
            let mackey = "host:mac:" + data.mac;
            rclient.hgetall(mackey, (err, data) => {
                callback(mackey, err, data);
            });
        });
    }

    scan(subnet, fast, callback) {
        this.publisher.publish("DiscoveryEvent", "Scan:Start", '0', {});
        this.nmap.scan(subnet, fast, (err, hosts, ports) => {
            this.hosts = [];
            for (let h in hosts) {
                let host = hosts[h];
                if (host.mac == null) {
                    log.debug("Discovery:Nmap:HostMacNull:", h, hosts[h]);
                    continue;
                }

                let key = "host:ip4:" + host.uid;
                log.debug("Discovery:Nmap:Scan:Found", key, host.mac, host.uid);
                rclient.hgetall(key, (err, data) => {
                    log.debug("Discovery:Nmap:Redis:Search", key, data, {});
                    if (err == null) {
                        if (data != null) {
                            let changeset = this.mergeHosts(data, host);
                            changeset['lastActiveTimestamp'] = Date.now() / 1000;
                            changeset['firstFoundTimestamp'] = data.firstFoundTimestamp;
                            log.info("Discovery:Nmap:Redis:Merge", key, changeset, {});
                            rclient.hmset(key, changeset, (err, result) => {
                                if (err) {
                                    log.error("Discovery:Nmap:Update:Error", err);
                                }
                            });
                        } else {
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
                                    this.publisher.publish("DiscoveryEvent", "Host:Found", "0", host);
                                }
                            });
                        }
                    } else {
                        log.error("Discovery:Nmap:Redis:Error", err);
                    }
                });
                if (host.mac != null) {
                    let key = "host:mac:" + host.mac.toUpperCase();;
                    log.debug("Discovery:Mac:Scan:Found", key, host.mac);
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
                                let c = this.hostCache[host.uid];
                                if (c && Date.now() / 1000 < c.expires) {
                                    data.name = c.name;
                                    data.bname = c.name;
                                    log.debug("Discovery:Nmap:HostCache:LookMac", c);
                                }
                            }
                            rclient.hmset(key, data, (err, result) => {
                                if (newhost == true) {
                                    let d = JSON.parse(JSON.stringify(data));
                                    let actionobj = {
                                         title: "New Host",
                                         actions: ["hblock","ignore"],
                                         target: data.ipv4Addr,
                                    }
                                    alarmManager.alarm(data.ipv4Addr, "newhost", 'major', '50', d, actionobj, null);
                                }
                            });
                        } else {

                        }
                    });
                }

            }
            /*
                        for (let p in ports) {
                             let port = ports[p];
                             this.DB.Port.DBModel.find({ where: {uid: port.uid} }).then((dbobj)=> {
                                if (dbobj) { // if the record exists in the db
                                    port.firstFoundTimestamp = dbobj.firstFoundTimestamp;
                                    dbobj.updateAttributes(
                                        port 
                                    );
                                } else {
                                    port.firstFoundTimestamp = Date.now()/1000; 
                                    this.DB.Port.DBModel.create(port);
                                }
                             });
                        }
             
                        this.DB.Port.DBModel.sync();
                        this.DB.Host.DBModel.sync();
                        this.DB.sync();
                     */

            console.log("Done Processing ++++++++++++++++++++");

            setTimeout(() => {
                callback(null, null);
                this.publisher.publish("DiscoveryEvent", "Scan:Done", '0', {});
                sysManager.setOperationalState("LastScan", Date.now() / 1000);
            }, 2000);
        });
    }

    //pi@raspbNetworkScan:~/encipher.iot/net2 $ ip -6 neighbor show
    //2601:646:a380:5511:9912:25e1:f991:4cb2 dev eth0 lladdr 00:0c:29:f4:1a:e3 STALE
    // 2601:646:a380:5511:9912:25e1:f991:4cb2 dev eth0 lladdr 00:0c:29:f4:1a:e3 STALE
    // 2601:646:a380:5511:385f:66ff:fe7a:79f0 dev eth0 lladdr 3a:5f:66:7a:79:f0 router STALE
    // 2601:646:9100:74e0:8849:1ba4:352d:919f dev eth0  FAILED  (there are two spaces between eth0 and Failed)

    addV6Host(v6addr, mac, callback) {
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
                    rclient.hgetall(mackey, (err, data) => {
                        log.debug("============== Discovery:v6Neighbor:Scan:mac", v6key, mac, mackey, data);
                        if (err == null) {
                            if (data != null) {
                                let ipv6array = [];
                                if (data.ipv6) {
                                    ipv6array = JSON.parse(data.ipv6);
                                }

                                if (ipv6array.indexOf(v6addr) == -1) {
                                    ipv6array.push(v6addr);
                                }
                                data.mac = mac.toUpperCase();
                                data.ipv6 = JSON.stringify(ipv6array);
                                data.ipv6Addr = JSON.stringify(ipv6array);
                                data.lastActiveTimestamp = Date.now() / 1000;
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

    neighborDiscoveryV6(intf) {
        this.process = require('child_process').exec("ping6 -c2 -I eth0 ff02::1", (err, out, code) => {
            let cmdline = 'ip -6 neighbor show';
            console.log("Running commandline: ", cmdline);

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
