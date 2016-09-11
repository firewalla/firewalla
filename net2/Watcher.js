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
var instances = {};

var redis = require("redis");
var rclient = redis.createClient();
var sclient = redis.createClient();
sclient.setMaxListeners(0);

var Spoofer = require('./Spoofer.js');
var spoofer = null;



rclient.on("error", function (err) {
    console.log("Redis(alarm) Error " + err);
});

class WNotice {
    constructor(ip, config, callback) {
        this.callbacks = {};
    }

    on(event, callback) {
        this.callbacks[event] = callback;
    }

    get(from, to, limit, summarized, callback) {}
}

class WFlow {
    constructor(ip, config, callback) {
        this.callbacks = {};
    }
    on(event, callback) {
        this.callbacks[event] = callback;
    }
    get(from, to, limit, summarized, callback) {}
};

class WSoftware {
    constructor(ip, config, callback) {
        this.callbacks = {};
    }

    on(event, callback) {
        this.callbacks[event] = callback;
    }

    get(from, to, limit, summarized, callback) {}
};

class Host {
    constructor(obj) {
        this.callbacks = {};
        this.o = obj;
        this.spoofing = false;
        log.debug("Host Object Initialized");
        sclient.on("message", (channel, message) => {
            this.processNotifications(channel, message);
        });
        if (obj != null) {
            this.subscribe(obj.ipv4Addr, "Notice");
        }
    }

    spoof(state) {
        if (state == true) {
            log.debug("Host:Spoof:True", this.o.ipv4Addr);
            spoofer.spoof(this.o.ipv4Addr, "192.168.2.1", true);
            this.spoofing = true;
        } else {
            log.debug("Host:Spoof:False", this.o.ipv4Addr);
            spoofer.unspoof(this.o.ipv4Addr, "192.168.2.1", true);
            this.spoofing = false;
        }
    }

    // Notice
    processNotifications(channel, message) {
        console.log("RX Notifcaitons", channel, message);
        if (channel.toLowerCase().indexOf("notice") >= 0) {
            if (this.callbacks.notice != null) {
                callback(host, channel, message);
            }
        }
    }

    subscribe(ip, e) {
        let channel = e + "Detected:" + ip;
        sclient.subscribe(e);
        log.debug("Watch:Subscribed:", channel, {});
    }

    listen(tell) {}

    stopListen() {}

    on(event, callback) {
        this.callbacks[event] = callback;
    }

    toShortString() {
        let name = "unknown";
        let ip = this.o.ipv4Addr;

        if (this.o.name != null) {
            name = this.o.name;
        } else if (this.o.macVendor != null) {
            name = "(?)" + this.o.macVendor;
        }

        let now = Date.now() / 1000;
        return ip + "\t" + name + " (" + (now - this.o.lastActiveTimestamp) / 60 + "m)";
    }

    summarizeSoftware(ip, from, to, callback) {
        rclient.zrevrangebyscore(["software:ip:" + ip, to, from], (err, result) => {
            let softwaresdb = {};
            if (err == null) {
                for (let i in result) {
                    let o = JSON.parse(result[i]);
                    let obj = softwaresdb[o.name];
                    if (obj == null) {
                        softwaresdb[o.name] = o;
                        o.lastActiveTimestamp = Number(o.ts);
                        o.count = 1;
                    } else {
                        if (obj.lastActiveTimestamp < Number(o.ts)) {
                            obj.lastActiveTimestamp = Number(o.ts);
                        }
                        obj.count += 1;
                    }
                }

                let softwares = [];
                for (let i in softwaresdb) {
                    softwares.push(softwaresdb[i]);
                }
                softwares.sort(function (a, b) {
                    return Number(b.count) - Number(a.count);
                })
                let softwaresrecent = softwares.slice(0);
                softwaresrecent.sort(function (a, b) {
                    return Number(b.lastActiveTimestamp) - Number(a.lastActiveTimestamp);
                })
                callback(null, softwares, softwaresrecent);
            } else {
                log.error("Unable to search software");
                callback(err, null, null);
            }

        });
    }

    summarizeHttpFlows(ip, from, to, callback) {
        rclient.zrevrangebyscore(["flow:http:in:" + ip, 'to', 'from', "LIMIT", 0, 1000], (err, results) => {
            if (err == null && results.length > 0) {
                for (let i in results) {
                    let flow
                }
            } else {
                log.error("Unable to search software");
                callback(err, null, null);
            }
        });
    }

    getHost(ip, callback) {
        let key = "host:ip4:" + ip;
        log.debug("Discovery:FindHostWithIP", key, ip);
        rclient.hgetall(key, (err, data) => {
            if (err == null && data != null) {
                this.o = data;
                this.summarizeSoftware(ip, '-inf', '+inf', (err, sortedbycount, sortedbyrecent) => {
                    //      rclient.zrevrangebyscore(["software:ip:"+ip,'+inf','-inf'], (err,result)=> {
                    this.softwareByCount = sortedbycount;
                    this.softwareByRecent = sortedbyrecent;
                    rclient.zrevrangebyscore(["notice:" + ip, '+inf', '-inf'], (err, result) => {
                        this.notice = result
                        rclient.zrevrangebyscore(["flow:http:in:" + ip, '+inf', '-inf', "LIMIT", 0, 10], (err, result) => {
                            this.http = result;
                            callback(null, this);
                        });
                    });
                });
            } else {
                log.error("Discovery:FindHostWithIP:Error", key, err);
                callback(err, null);
            }
        });
    }
}

var sysinfo = null;

module.exports = class {
    constructor(name, config, loglevel) {
        if (instances[name] == null) {
            log = require("./logger.js")("discovery", loglevel);
            this.name = name;
            this.config = config;
            this.callbacks = {
                notice: {},
                flow: {},
                host: {}
            };
            rclient.hgetall("sys:network:info", (err, results) => {
                if (err == null) {
                    sysinfo = results;
                    for (let r in sysinfo) {
                        sysinfo[r] = JSON.parse(sysinfo[r]);
                    }
                    spoofer = new Spoofer("eth0", {}, true);

                }
            });
            instances[name] = this;
        }
        return instances[name];
    }


    on(module, event, callback) {
        if (this.callbacks[module] == null) {
            return false;
        }
        this.callbacks[module][event] = callback;
    }

    getHost(ip, callback) {
        log.debug("Getting host for ", ip);

        let host = new Host(null);
        host.getHost(ip, callback);
    }

    getHosts(callback) {
        rclient.keys("host:ip4:*", (err, keys) => {
            let multiarray = [];
            for (let i in keys) {
                multiarray.push(['hgetall', keys[i]]);
            }
            rclient.multi(multiarray).exec((err, replies) => {
                let hosts = [];
                for (let i in replies) {
                    let host = new Host(replies[i]);
                    hosts.push(host);
                }
                hosts.sort(function (a, b) {
                    return Number(b.o.lastActiveTimestamp) - Number(a.o.lastActiveTimestamp);
                })
                callback(err, hosts);
            });
        });
    }
}
