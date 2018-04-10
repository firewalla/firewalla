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

const rclient = require('../util/redis_manager.js').getRedisClient()

var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');

var _async = require('async');
var instance = null;

const Promise = require('bluebird');

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const IntelTool = require('../net2/IntelTool.js')
const intelTool = new IntelTool()

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool();

var bone = require('../lib/Bone.js');
var flowUtil = require('../net2/FlowUtil.js');

const getPreferredBName = require('../util/util.js').getPreferredBName

const DNSQUERYBATCHSIZE=5;


var hostManager = null;

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
        _async.eachLimit(list,10, (o, cb) => {
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
    let enrichDstCount = 0;
    let enrichDeviceCount = 0;
    let start = Math.ceil(Date.now() / 1000);
    let tid = Math.ceil(start+Math.random()*100);
    log.info("QUERY: Resoving list[",tid,"] ", list.length);
    _async.eachLimit(list, DNSQUERYBATCHSIZE, (o, cb) => {
      // filter out short connections
      let lhost = hostManager.getHostFast(o.lh);
      if (lhost) {
        if (lhost.isFlowAllowed(o) == false) {
          log.info("### NOT LOOKUP6 ==:", o);
          flowUtil.addFlag(o, 'l'); // 
          //flowUtil.addFlag(o,'x'); // need to revist on if need to ignore this flow ... most likely these flows are very short lived
          // cb();
          // return;
        }
      }

      if (o.fd == "in") {
        if (o.du && o.du < 0.0001) {
          //log.info("### NOT LOOKUP 1:",o);
          flowUtil.addFlag(o, 'x');
          cb();
          return;
        }
        if (o.ob && o.ob == 0 && o.rb && o.rb < 1000) {
          //log.info("### NOT LOOKUP 2:",o);
          flowUtil.addFlag(o, 'x');
          cb();
          return;
        }
        if (o.rb && o.rb < 1500) { // used to be 2500
          //log.info("### NOT LOOKUP 3:",o);
          flowUtil.addFlag(o, 'x');
          cb();
          return;
        }
        if (o.pr && o.pr == 'tcp' && (o.rb == 0 || o.ob == 0) && o.ct && o.ct <= 1) {
          flowUtil.addFlag(o, 'x');
          log.info("### NOT LOOKUP 4:", o);
          cb();
          return;
        }
      } else {
        if (o.pr && o.pr == 'tcp' && (o.rb == 0 || o.ob == 0)) {
          flowUtil.addFlag(o, 'x');
          log.info("### NOT LOOKUP 5:", o);
          cb();
          return;
        }
      }

      resolve++;

      async(() => {
        const _ipsrc = o[ipsrc]
        const _ipdst = o[ipdst]

        if(sysManager.isLocalIP(_ipsrc)) {
          enrichDeviceCount++;
          await(this.enrichDeviceIP(_ipsrc, o, "src"))
        } else {
          enrichDstCount++;
          await (this.enrichDestIP(_ipsrc, o, "src"))
        }

        if(sysManager.isLocalIP(_ipdst)) {
          enrichDeviceCount++;
          await(this.enrichDeviceIP(_ipdst, o, "dst"))
        } else {
          enrichDstCount++;
          await (this.enrichDestIP(_ipdst, o, "dst"))
        }
      })().finally(() => {
        cb()
      })
    }, (err) => {
      log.info("DNS:QUERY:RESOLVED:COUNT[",tid,"] (", resolve,"/",list.length,"):", enrichDeviceCount, enrichDstCount, Math.ceil(Date.now() / 1000) - start,start);
      if(err) {
        log.error("Failed to call dnsmanager.query:", err, {})
      }
      callback(err);
    });
  }

  enrichDeviceIP(ip, flowObject, srcOrDest) {
    return async(() => {
      const macEntry = await (hostTool.getMacEntryByIP(ip))
      if(macEntry) {
        if(srcOrDest === "src") {
          flowObject["shname"] = getPreferredBName(macEntry)
        } else {
          flowObject["dhname"] = getPreferredBName(macEntry)
        }        

        flowObject.mac = macEntry.mac
      }
    })().catch((err) => {
      // do nothing
    })
  }

  enrichDestIP(ip, flowObject, srcOrDest) {
    return async(() => {
      const intel = await (intelTool.getIntel(ip))
      if(intel) {
        if(intel.host) {
          if(srcOrDest === "src") {
            flowObject["shname"] = intel.host
          } else {
            flowObject["dhname"] = intel.host
          }        
        }

        if(intel.org) {
          flowObject.org = intel.org
        }

        if(intel.app) {
          flowObject.app = intel.app
          flowObject.appr = intel.app         
        }

        if(intel.category) {
          flowObject.category = intel.category
        }

        flowObject.intel = intel
      }
    })().catch((err) => {
      // do nothing
    })
  }
}
