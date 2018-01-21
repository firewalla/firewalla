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

var iptool = require('ip');
var os = require('os');
var network = require('network');
var instances = {};

var redis = require("redis");
var rclient = redis.createClient();

var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');

rclient.on("error", function (err) {
    log.info("Redis(alarm) Error " + err);
});

var async = require('async');
var instance = null;

var bone = require('../lib/Bone.js');
var flowUtil = require('../net2/FlowUtil.js');

var hostManager = null;

let Promise = require('bluebird');
let firewalla = require('./Firewalla.js');

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
        }
        return instance;
    }

    resolveMac(mac,callback) {
        if (mac == null) {
            callback(null,null)
        } else {
            rclient.hgetall("host:mac:" + mac, (err, data) => {
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
                if (data && data._intel) {
                    data.intel = JSON.parse(data._intel);
                }
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
            //log.info('resolving ', key0);
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
                //log.info("====================== Resolved",ip,data);
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
                        callback(null,d,ddata);
                    } else {
                        callback(null, null,null);
                    }
                //});
            }
        });
    }

    resolvehost(ip, callback) {
        if (ip == null){
          callback(null,null);
          return;
        }
        if (sysManager.isLocalIP(ip)) {
            this.resolveLocalHost(ip, callback);
        } else {
            this.resolveRemoteHost(ip, callback);
        }
    }

    _getIntel(ip, flow, callback) {
      
    }
  getIntel(ip, flow, dnsdata, now, callback) {
        log.debug("Get Intel:",ip);
        if (dnsdata) {
            if (dnsdata._intel) {
                let intel = JSON.parse(dnsdata._intel);
                // rcount == 1, if we only got intel of the ip address ... 
                // in order to use the cache, 
                log.debug("Intel:Cached", ip, dnsdata,intel);
                if (intel && intel.ts && intel.ts>(now/1000-48*60*60)) { // otherwise expired
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
                        callback(null, intel); 
                        return;
                    }
                    log.debug("Intel:Cached Passed", ip);
                } else {
                    log.debug("Intel:Cached Failed", ip,intel,dnsdata);
                    //log.info("### Intel:Cached Failed", ip,intel,dnsdata);
                }
            } else {
                //log.info("### Intel:Cached Failed2", ip,JSON.stringify(dnsdata));
            }
        }  else {
            //callback(null,null);
            //return;
            dnsdata = {};
        }

        let hashdebug = sysManager.isSystemDebugOn() || !firewalla.isProduction();
        log.info("######################### CACHE MISS ON IP ",hashdebug,ip,dnsdata,flowUtil.dhnameFlow(flow));
        let _iplist = [];
        let _alist = [];
        let _hlist = [];
        let hlist = [];
        let alist = [];
        let iplist = [];
        let flowlist = [];
        if (flow.af && Object.keys(flow.af).length>0) {
            for (let host in flow.af) {
                _iplist = _iplist.concat(flowUtil.hashHost(host)); // backward compatibility for now
                _alist = _alist.concat(flowUtil.hashApp(host));
                alist.push(host);
            }
        } 
        if (dnsdata && dnsdata.host) {
            _iplist = _iplist.concat(flowUtil.hashHost(dnsdata.host)); // backward compatibility for now
            hlist.push(dnsdata.host);
            _hlist = _hlist.concat(flowUtil.hashHost(dnsdata.host));
            _alist = _alist.concat(flowUtil.hashApp(dnsdata.host));
            alist.push(dnsdata.host);
        } 

        iplist.push(ip);
        _iplist = _iplist.concat(flowUtil.hashHost(ip));

        if (iplist.indexOf("firewalla.encipher.io") > -1 ||
              hlist.indexOf("firewalla.encipher.io")> -1) {
           log.debug("###Intel:DNS:SkipSelf",iplist,flow);
           callback(null,null);
           return; 
        }

        let _flow = flowUtil.hashFlow(flow,!hashdebug);

        if (hashdebug == false) {
            flowlist.push({_iplist:_iplist,_alist:_alist,_hlist:_hlist,flow:_flow});
        } else {
            flowlist.push({iplist:iplist, _iplist:_iplist,alist:alist,_alist:_alist,hlist:hlist, _hlist:_hlist,flow:_flow});
        }

        log.info("######## Sending:",JSON.stringify(flowlist));

        bone.intel("*", "", "check",{flowlist:flowlist, hashed:1},(err,data)=> {
           if (err || data == null || data.length ==0) {
               log.debug("##### MISS",err,data);
               if (data && data.length == 0) {
                 
                 // if nothing found, record the timestamp
                   let intel = {ts:Math.floor(Date.now()/1000)};
                   intel.rcount = iplist.length;
                   let key = "dns:ip:"+ip;
                   //log.info("##### MISS 3",key,"error:",err,"intel:",intel,JSON.stringify(r));
                   dnsdata.intel = intel;
                   dnsdata._intel = JSON.stringify(intel);
                   rclient.hset(key, "_intel", JSON.stringify(intel),(err,data)=> {
                       rclient.expireat(key, parseInt((+new Date) / 1000) + 43200*2);
                       callback(err,null);
                   });
               }

               return;
           }
           let rintel = null;
           async.eachLimit(data, 1, (r, cb) => {
              if (rintel) { // for now only look at the first intel ignore rest
                  cb();
                  return;
              }
              if (r.c || r.apps) {
                  let key = "dns:ip:"+ip;
                  if (rintel == null) {
                      rintel = r;  
                  }
                  dnsdata.intel = r;
                  dnsdata._intel = JSON.stringify(r);
                  //log.info("##### MISS 2",key,err,JSON.stringify(r));
                  rclient.hset(key, "_intel", JSON.stringify(r),(err,data)=> {
                      //log.info("##### MISS 2 SAVED ",key,err,JSON.stringify(r),data);
                      rclient.expireat(key, Math.floor(Date.now()/1000)+43200*2);
                      cb();
                  });
              } else {
                  let intel = {ts:Math.floor(Date.now()/1000)};
                  intel.rcount = iplist.length;
                  let key = "dns:ip:"+ip;
                  //log.info("##### MISS 3",key,"error:",err,"intel:",intel,JSON.stringify(r));
                  dnsdata.intel = intel;
                  dnsdata._intel = JSON.stringify(intel);
                  rclient.hset(key, "_intel", JSON.stringify(intel),(err,data)=> {
                      rclient.expireat(key, parseInt((+new Date) / 1000) + 43200*2);
                      cb(); 
                  });
              }
           },(err)=> {
                callback(err, rintel);
           });
        }); 
    }
  resolveAny(ip,flow, now, callback) {
        this.resolveLocalHost(ip, (err, data) => {
            if (data) {
                callback(null, data, true);
            } else {
                this.resolvehost(ip, (err, data2,dnsdata) => {
                    if (data2 == null) {
                        data2 = {};
                    }
                  this.getIntel(ip,flow, dnsdata,now, (err,intel)=> {
                        if (intel) {
                            data2['intel']=intel;
                            if (intel.s) {
                                 log.debug("#################### GOT INTEL2",data2,intel,{});
                            }
                            if (intel.apps) {
                                for (let i in intel.apps) {
                                    data2['appr'] = i;
                                    break;
                                }
                            }
                        }
                        if (data2.appr) {
                            //log.info("#######################3 APPR ", data2);
                        }
                        callback(null, data2,false);
                      });
                });
            }
        });
    }

    name(o) {

        const getPreferredBName = require('../util/util.js').getPreferredBName

        return getPreferredBName(o)

        if (o==null) {
            return null;
        }
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


/*
> [ { address: '104.20.23.46', family: 4 },
  { address: '104.20.22.46', family: 4 },
  { address: '2400:cb00:2048:1::6814:162e', family: 6 },
  { address: '2400:cb00:2048:1::6814:172e', family: 6 } ]

*/


    dnsLookup(host,callback) {
        if (host == null) {
            callback(null,null);
        } else {
            dns.lookup(host, {all:true},(err, addresses, family) => {
                let v4=[];
                let v6=[];
                let all = [];
                for (let i in addresses) {
                    if (addresses[i].family==4) {
                        v4.push(addresses[i].address);
                    }
                    if (addresses[i].family==6) {
                        v6.push(addresses[i].address);
                    }
                    all.push(addresses[i].address);
                }
                callback(err, all,v4,v6);
            });
        }
    }

    queryAcl(list, callback) {
        if (list == null || list.length == 0) {
            callback(null,list);
            return;
        }
        let ipchanged = false;
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
                         if (o.src != data.ipv4) {
                             o._src = data.ipv4;
                             ipchanged = true;
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
                             if (o.dst != data.ipv4) {
                                o._dst = data.ipv4;
                                ipchanged = true;
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
            callback(err,list,ipchanged);
        });    
     
    }

    // Need to write code to drop the noise before calling this function.
    // this is a bit expensive due to the lookup part

  // will place an x over flag or f if the flow is not really valid ...
  // such as half tcp session
  // 
  // incase packets leaked via bitbridge, need to see how much they are and
  // consult the blocked list ...  
  // 
  // if x is there, the flow should not be used or presented.  It only be used
  // for purpose of accounting

  query(list, ipsrc, ipdst, callback) {

    // use this as cache to calculate how much intel expires
    // no need to call Date.now() too many times.
    if (hostManager == null) {
        let HostManager = require("../net2/HostManager.js");
        hostManager = new HostManager("cli", 'client', 'info');
    }

    let now = Date.now(); 
    
        if (list == null || list.length == 0) {
            callback(null);
            return;
        }
        let resolve = 0;
        let start = Math.ceil(Date.now()/1000);
        log.info("Resoving list",list.length);
        async.eachLimit(list,20, (o, cb) => {
            // filter out short connections
            let lhost = hostManager.getHostFast(o.lh);
            if (lhost) {
                if (lhost.isFlowAllowed(o) == false) {
                     log.info("### NOT LOOKUP6 ==:",o);
                     flowUtil.addFlag(o,'l'); // 
                     //flowUtil.addFlag(o,'x'); // need to revist on if need to ignore this flow ... most likely these flows are very short lived
                     // cb();
                     // return;
                }
            }

            if (o.fd == "in") {
                if (o.du && o.du<0.0001) {
                     //log.info("### NOT LOOKUP 1:",o);
                     flowUtil.addFlag(o,'x');
                     cb();
                     return;
                }
                if (o.ob && o.ob == 0 && o.rb && o.rb<1000) {
                     //log.info("### NOT LOOKUP 2:",o);
                     flowUtil.addFlag(o,'x');
                     cb();
                     return;
                }
                if (o.rb && o.rb <1500) { // used to be 2500
                     //log.info("### NOT LOOKUP 3:",o);
                     flowUtil.addFlag(o,'x');
                     cb();
                     return;
                }
                if (o.pr && o.pr =='tcp' && (o.rb==0 || o.ob==0) && o.ct && o.ct<=1) {
                     flowUtil.addFlag(o,'x');
                     log.info("### NOT LOOKUP 4:",o);
                     cb();
                     return;
                }
            } else {
                if (o.pr && o.pr =='tcp' && (o.rb==0 || o.ob==0)) {
                     flowUtil.addFlag(o,'x');
                     log.info("### NOT LOOKUP 5:",o);
                     cb();
                     return;
                }
            }

            resolve++;
          this.resolveAny(o[ipsrc],o, now, (err, data, local) => {
            if (data) {
              o['shname'] = this.name(data);
                    o['org'] = data.org;
                    o['appr'] = data.appr;
                    if (data.intel && data.intel.c) {
                        o['intel'] = data.intel;
                        log.debug("DNS:QUERY:RESOLVED:INTEL:",o[ipsrc],o,{});
                    }
                    if (local == true) {
                        o['mac'] = data.mac;
                    }
                   
                }
            this.resolveAny(o[ipdst],o, now, (err, data,local) => {
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
                            log.debug("DNS:QUERY:RESOLVED:INTEL22:",o[ipdst],o,{});
                        }
                        if (local == true) {
                            o['mac'] = data.mac;
                        }
                    }
                    cb();
                });
            });
        }, (err) => {
            log.info("DNS:QUERY:RESOLVED:COUNT",resolve,list.length,Math.ceil(Date.now()/1000)-start);
            callback(err);
        });
    }
}
