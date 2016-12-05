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
var iptool = require('ip');
var os = require('os');
var network = require('network');
var instances = {};

var redis = require("redis");
var rclient = redis.createClient();

var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');

rclient.on("error", function (err) {
    console.log("Redis(alarm) Error " + err);
});

var async = require('async');
var instance = null;

var bone = require('../lib/Bone.js');

const dns = require('dns');

function parseX509Subject(subject) {
    let array = subject.split(',');
    let result = {};
    for (let i in array) {
        let obj = array[i].split("=");
        if (obj.length == 2) {
            result[obj[0]] = obj[1];
        }
    }

    return result;
}

module.exports = class DNSManager {
    constructor(loglevel) {
        if (instance == null) {
            instance = this;
            log = require("./logger.js")("DNSManager", loglevel);
        }
        return instance;
    }

    resolveMac(mac,callback) {
        if (mac == null) {
            callback(null,null)
        } else {
            rclient.hgetall("host:mac:" + data.mac, (err, data) => {
                if (err == null && data != null) {
                     callback(err, data);
                } else {
                     callback(err, null);
                }
            });
        }
    }

    // Reslve v6 or v4 address into a local host
    resolveLocalHost(ip, callback) {
        if (iptool.isV4Format(ip)) {
            rclient.hgetall("host:ip4:" + ip, (err, data) => {
                if (data && data.mac) {
                    rclient.hgetall("host:mac:" + data.mac, (err, data) => {
                        if (err == null && data != null) {
                            callback(err, data);
                        } else {
                            callback(err, null);
                        }
                    });

                } else {
                    callback("404", null);
                }
            });
        } else if (iptool.isV6Format(ip)) {
            rclient.hgetall("host:ip6:" + ip, (err, data) => {
                if (err == null && data != null) {
                    if (data.mac) {
                        rclient.hgetall("host:mac:" + data.mac, (err, data) => {
                            if (err == null && data != null) {
                                callback(err, data);
                            } else {
                                callback(err, null);
                            }
                        });
                    } else {
                        callback(null, null);
                    }
                } else {
                    callback(err, null);
                }
            });
        } else {
            log.error("DNSManager:ResolveHost:Error", ip);
            callback("bad ip", null);
        }
    }

    findHostWithIP(ip, callback) {
        let key = "host:ip4:" + ip;
        log.debug("DNS:FindHostWithIP", key, ip);
        rclient.hgetall(key, (err, data) => {
            let mackey = "host:mac:" + data.mac;
            rclient.hgetall(mackey, (err, data) => {
                callback(mackey, err, data);
            });
        });
    }

    resolveLookup(ip, callback) {
        let key0 = "host:ext.x509:" + ip;
        rclient.hgetall(key0, (err, xdata) => {
            let key1 = "dns:ip:" + ip;
            rclient.hgetall(key1, (err, data) => {
                callback(err, xdata,data);
            });
        });
    }


    resolveRemoteHost(ip, callback) {
        let key0 = "host:ext.x509:" + ip;
        let O = null;
        let H = null;
        //rclient.hgetall(key0, (err, data) => {
        this.resolveLookup(ip,(err,data,ddata)=>{
            //console.log('resolving ', key0);
            if (data != null) {
                H = data['server_name'];
                let obj = parseX509Subject(data['subject']);
                if (obj) {
                    O = obj['O'];
                    if (obj['O'] == null) {
                        O = "!";
                    }
                } else {
                    O = "!";
                }
                //console.log("====================== Resolved",ip,data);
            }
            if (H != null) {
                if (O != null) {
                    callback(null, {
                        ip: ip,
                        name: H,
                        org: O
                    },ddata);
                } else {
                    callback(null, {
                        ip: ip,
                        name: H
                    },ddata);
                }
            } else {
                let key1 = "dns:ip:" + ip;
                //rclient.hgetall(key1, (err, data) => {
                    if (ddata && ddata._intel) { 
                        ddata.intel = JSON.parse(ddata._intel);
                    }
                    if (ddata != null) {
                        let d = null;
                        if (O != null) {
                            d = {
                                ip: ip,
                                name: ddata.host,
                                org: O
                            };
                        } else {
                            d = {
                                ip: ip,
                                name: ddata.host
                            };
                        }
                        rclient.hgetall(ddata.host, (err, data2) => {
                            if (data2 != null) {
                                if (O != null) {
                                    d = {
                                        ip: ip,
                                        name: data2.host,
                                        org: O
                                    };
                                } else {
                                    d = {
                                        ip: ip,
                                        name: data2.host
                                    };
                                }
                                callback(err, d,ddata);
                            } else {
                                callback(err, d,ddata);
                            }
                        });

                    } else {
                        callback(null, null);
                    }
                //});
            }
        });
    }

    resolvehost(ip, callback) {
        if (sysManager.isLocalIP(ip)) {
            this.resolveLocalHost(ip, callback);
        } else {
            this.resolveRemoteHost(ip, callback);
        }
    }

    getIntel(ip, flow, dnsdata,  callback) {
        log.info("Get Intel:",ip);
        if (dnsdata) {
            if (dnsdata._intel) {
                let intel = JSON.parse(dnsdata._intel);
                // rcount == 1, if we only got intel of the ip address ... 
                // in order to use the cache, 
                log.info("Intel:Cached", ip, dnsdata,intel);
                if (intel && intel.ts && intel.ts>(Date.now()/1000-24*60*60)) { // otherwise expired
                    if (intel.c!=null || intel.apps!=null) {
                        callback(null, JSON.parse(dnsdata._intel));
                        return;
                    } else if (dnsdata.host == null && intel.rcount && intel.rcount == 1) {
                        callback(null, JSON.parse(dnsdata._intel));
                        return;
                    } else if (dnsdata.host != null && intel.rcount && intel.rcount != 1) {
                        callback(null, JSON.parse(dnsdata._intel));
                        return;
                    } else {
                   
                    }
                    log.info("Intel:Cached Passed", ip);
                }
            }
        }  else {
            log.info("Intel:DNSNULL:", ip);
            //callback(null,null);
            //return;
            dnsdata = {};
        }

        console.log("#########3 CACHE MISS ON IP",ip);
        let iplist = [];
        let flowlist = [];
        if (flow.af && Object.keys(flow.af).length>0) {
            for (let host in flow.af) {
                iplist.push(host);
            }
        } else if (dnsdata && dnsdata.host) {
            iplist.push(dnsdata.host);
        } 

        iplist.push(ip);

        if (iplist.indexOf("firewalla.encipher.io") > -1) {
           log.info("###Intel:DNS:SkipSelf",iplist,flow);
           callback(null,null);
           return; 
        }

        flowlist.push({iplist:iplist,flow:flow});

        bone.intel("*","check",{flowlist:flowlist},(err,data)=> {
           if (err || data == null) {
               callback(err,null);
               return;
           }
           let rintel = null;
           async.eachLimit(data, 1, (r, cb) => {
              if (rintel) { // for now only look at the first intel ignore rest
                  cb();
                  return;
              }
              if (r.c || r.apps) {
                  log.info("#################### GOT INTEL",r,dnsdata,{});
                  dnsdata.intel = r;
                  let key = "dns:ip:"+ip;
                  if (rintel == null) {
                      rintel = r;  
                  }
                  rclient.hset(key, "_intel", JSON.stringify(r),(err,data)=> {
                      log.info("##### GOT INTEL 3",ip,data,{});
                      cb();
                      rclient.expireat(key, parseInt((+new Date) / 1000) + 43200*2);
                  });
              } else {
                  // Inert code to write empty intel ... this will prevent future checks
                  // this ts field is also useful here if set 
                  let intel = {ts:Date.now()/1000};
                  intel.rcount = iplist.length;
                  let key = "dns:ip:"+ip;
                  dnsdata.intel = intel;
                  rclient.hset(key, "_intel", JSON.stringify(intel),(err,data)=> {
                      cb(); 
                      rclient.expireat(key, parseInt((+new Date) / 1000) + 43200*2);
                  });
              }
           },(err)=> {
                callback(err, rintel);
           });
        }); 
    }
    resolveAny(ip,flow, callback) {
        this.resolveLocalHost(ip, (err, data) => {
            if (data) {
                callback(null, data, true);
            } else {
                this.resolvehost(ip, (err, data2,dnsdata) => {
                    if (data2 == null) {
                        log.info("###### ERROR looking up",ip);
                        data2 = {};
                    }
                      this.getIntel(ip,flow, dnsdata,(err,intel)=> {
                        if (intel) {
                            data2['intel']=intel;
                            if (intel.s) {
                                 log.info("#################### GOT INTEL2",data2,intel,{});
                            }
                            if (intel.apps) {
                                for (let i in intel.apps) {
                                    data2['appr'] = i;
                                    break;
                                }
                            }
                        }
                        if (data2.appr) {
                            console.log("#######################3 APPR ", data2);
                        }
                        callback(null, data2,false);
                      });
                });
            }
        });
    }

    name(o) {
        if (o.name) {
            return o.name;
        }
        if (o.bname) {
            return o.bname;
        }
        if (o.pname) {
            return o.pname;
        }
        if (o.hostname) {
            return o.hostname;
        }
        if (o.macVendor != null) {
            let name = "(?)" + o.macVendor;
            return name;
        }
        return o.ipv4Addr;
    }


    dnsLookup(host,callback) {
        if (host == null) {
            callback(null,null);
        } else {
            dns.lookup(host, (err, addresses, family) => {
                callback(err, addresses);
            });
        }
    }

    queryAcl(list, callback) {
        if (list == null || list.length == 0) {
            callback(null,list);
            return;
        }
        async.eachLimit(list,10, (o, cb) => {
            o.srcs = [];
            o.dsts = [];
            if (sysManager.isLocalIP(o.src)) {
                 this.resolveMac(o.mac,(err,data)=> {
                     if (data!=null) {
                         o.srcs = [];
                         o.srcs.push(data.ipv4);
                         if (data.ipv6Addr!=null) {
                            let ipv6 = JSON.parse(data.ipv6Addr);
                            ipv6 = ipv6.slice(Math.max(ipv6.length - 3)) 
                            o.srcs = o.srcs.concat(ipv6); 
                         }  
                     } else {
                         o.srcs = [o.src];
                     }
                     if (o.dhname) {
                          this.dnsLookup(o.dhname,(err, list)=> {
                              if (list && list.length>0) {
                                  o.dsts = o.dsts.concat(list);
                              } else {
                                  o.dsts = [o.dst];
                              }
                              cb();
                          });
                     } else {
                          o.dsts = [o.dst];
                          cb();
                      }
                 });
            } else {
                 this.dnsLookup(o.shname,(err, list)=> {
                     if (list && list.length>0) {
                         o.srcs = o.srcs.concat(list);
                     } else {
                         o.srcs = [o.src];
                     }
                     this.resolveMac(o.mac,(err,data)=> {
                         if (data!=null) {
                             o.dsts = [];
                             o.dsts.push(data.ipv4);
                             if (data.ipv6Addr!=null) {
                                let ipv6 = JSON.parse(data.ipv6Addr);
                                ipv6 = ipv6.slice(Math.max(ipv6.length - 3)) 
                                o.dsts = o.dsts.concat(ipv6); 
                             }  
                             cb();
                         } else {
                             o.dsts = [o.dst];
                             cb();
                         }
                     });
                 });
            } 
        },(err)=> {
            log.info("DNS:QueryACL:",list,{});
            callback(err,list);
        });    
     
    }

    // Need to write code to drop the noise before calling this function.
    // this is a bit expensive due to the lookup part

    query(list, ipsrc, ipdst, callback) {
        if (list == null || list.length == 0) {
            callback(null);
        }
        async.eachLimit(list,10, (o, cb) => {
            // filter out short connections

            if (o.du && o.du<0.0001) {
                 //console.log("### NOT LOOKUP 1:",o);
                 cb();
                 return;
            }
            if (o.ob && o.ob == 0 && o.rb && o.rb<1000) {
                 //console.log("### NOT LOOKUP 2:",o);
                 cb();
                 return;
            }
            if (o.rb && o.rb <2500) {
                 //console.log("### NOT LOOKUP 3:",o);
                 cb();
                 return;
            }
            
            this.resolveAny(o[ipsrc],o, (err, data, local) => {
                if (data) {
                    o['shname'] = this.name(data);
                    o['org'] = data.org;
                    o['appr'] = data.appr;
                    if (data.intel && data.intel.c) {
                        o['intel'] = data.intel;
                        log.info("DNS:QUERY:RESOLVED:INTEL:",o[ipsrc],o,{});
                    }
                    if (local == true) {
                        o['mac'] = data.mac;
                    }
                   
                }
                this.resolveAny(o[ipdst],o, (err, data,local) => {
                    if (data) {
                        o['dhname'] = this.name(data);
                        if (data.org) {
                            o['org'] = data.org;
                        }
                        if (data.appr) {
                            o['appr'] = data.appr;
                        }
                        if (data.intel && data.intel.c) {
                            o['intel'] = data.intel;
                            log.info("DNS:QUERY:RESOLVED:INTEL22:",o[ipdst],o,{});
                        }
                        if (local == true) {
                            o['mac'] = data.mac;
                        }
                    }
                    cb();
                });
            });
        }, (err) => {
            callback(err);
        });
    }
}
