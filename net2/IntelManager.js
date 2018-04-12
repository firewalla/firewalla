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

let instance = null;

const log = require('./logger.js')(__filename);

const request = require('request');
const SysManager = require('./SysManager.js');
const sysManager = new SysManager('info');

const rclient = require('../util/redis_manager.js').getRedisClient()

const bone = require("../lib/Bone.js");
const IntelTool = require('./IntelTool');
const intelTool = new IntelTool();

const A_WEEK = 3600 * 24 * 7;

/* malware, botnet, spam, phishing, malicious activity, blacklist, dnsbl */
const IGNORED_TAGS = ['dnsbl', 'spam'];

module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            instance = this;
        }
        return instance;
    }

    action(action, ip, callback) {
        if (action === "ignore") {
            rclient.hmset("intel:action:"+ip, {'ignore':true}, (err)=> {
                callback(err,null);
            });
        } else if (action === "unignore") {
            rclient.hmset("intel:action:"+ip, {'ignore':false}, (err)=> {
                callback(err,null);
            });
        } else if (action === "block") {
        } else if (action === "unblock") {
        } else if (action === "support") {
        }

      bone.intel(ip, "", action, {});
    }

    async cacheLookupAsync(dest, origin) {
        return await rclient.getAsync("cache.intel:" + origin + ":" + dest);
    }

    cachelookup(ip, origin, callback) {
        rclient.get("cache.intel:" + origin + ":" + ip, (err, result) => {
            callback(err, result);
        });
    }

    cacheAdd(ip, origin, value) {
        if (value == null) {
            value = "none";
        }
        rclient.set("cache.intel:" + origin + ":" + ip, value, (err, result) => {
          rclient.expireat("cache.intel:" + origin + ":" + ip, this.currentTime() + A_WEEK);
        });
    }

    currentTime() {
      return Math.round(Date.now() / 1000);
    }
  
    async lookupDomain(domain, ip, flowObj) {
      if (!domain || domain === "firewalla.com") {
        return;
      }
  
      if (await this.isIgnored(domain)) {
        log.info("Ignored domain:", domain, "skip...");
        return;
      }

      let intel = flowObj.intel;

      intel.category = intel.category || flowObj.category;

      if (!intel.category) {
        log.info("No intel for domain", domain, "look up Bone...");
        intel = await this._lookupDomain(domain, ip);
      } else {
        log.info("Intel for domain", domain, " exists in flowObj");
        intel = this.processCloudIntel(intel);
      }
      log.info(`Intel for domain ${domain} is`, intel);
  
      return intel;
    }
    
    async isIgnored(target) {
      let data = await rclient.hgetallAsync("intel:action:" + target);
      log.info("Ignore check for domain:", target, " is", data);
      return data && data.ignore;
    }

    getDomainIntelKey(domain) {
      return `intel:domain:${domain}`;
    }
      
    async cacheDomainIntelAdd(domain, intel) {
      if (!domain || !intel) {
        return;
      }
      let key = this.getDomainIntelKey(domain);
      log.info("Domain intel key is", key);
      
      await rclient.hmsetAsync(key, intel);
      await rclient.expireatAsync(key, this.currentTime() + A_WEEK);
      
      log.info("Save cache success", key, "=>", intel);
    }

    async cacheDomainIntelLookup(domain) {
      return await rclient.hgetallAsync(this.getDomainIntelKey(domain));
    }
    
    async _lookupDomain(domain, ip) {
      let cloudIntel;
      try {
        cloudIntel = await intelTool.checkIntelFromCloud([ip], [domain], 'out');
      } catch (err) {
        log.info("Error when check intel from cloud", err);
      }
      log.info("Bone intel for ", domain, "is: ", cloudIntel);

      return this.processCloudIntel(cloudIntel[0]);
    }

  processCloudIntel(cloudIntel) {
    if (!cloudIntel) {
      return;
    }

    let intel = {};
    // check if the host matches the result from cloud
    // FIXME: ignore IP check because intel result from cloud does
    // NOT have "ip" all the time.
    if (cloudIntel.apps) {
      intel.apps = JSON.stringify(cloudIntel.apps);
      let keys = Object.keys(cloudIntel.apps);
      if (keys && keys[0]) {
        intel.app = keys[0];
      }
    }

    if (cloudIntel.c) {
      intel.category = cloudIntel.c;
    }

    if (cloudIntel.action && cloudIntel.action.block) {
      intel.action = "block"
    }

    if (cloudIntel.s) {
      intel.s = cloudIntel.s;
    }

    if (cloudIntel.t) {
      intel.t = cloudIntel.t;
    }

    if (cloudIntel.cc) {
      try {
        cloudIntel.cc = JSON.parse(cloudIntel.cc);
        intel.cc = cloudIntel.cc[0];
      } catch (err) {
        intel.cc = cloudIntel.cc;
        log.warn("Error when parsing info.cc:", cloudIntel.cc, err);
      }
    }
    return intel;
  }

  lookup(ip, intel, callback) {
        if (!ip || ip === "8.8.8.8" || sysManager.isLocalIP(ip)) {
            callback(null, null, null);
            return;
        }

        rclient.hgetall("intel:action:"+ip, (err,data) => {
            if (data && data.ignore) {
                log.info("Intel:Lookup:Ignored",ip);
                callback(null,null,null);
            }

            this.cachelookup(ip, "cymon", (err, result) => {
                if (result && result !== "none") {
                    this._location(ip, (err, lobj)=>{
                        let obj = JSON.parse(result);
                        if (!obj || obj.count === 0) {
                            obj = {}
                            obj.lobj = lobj;
                            obj = this._packageIntel(ip, obj, intel);
                            callback(null, obj); 
                        } else {
                            obj.lobj = lobj;
                            log.info("Intel:Location",ip,obj.lobj);
                            this._packageCymon(ip, obj);
                            callback(err, obj);
                        }
                    });
                } else {
                    this._lookup(ip, intel, (err, obj)=>{
                        callback(err,obj);
                    });
                }
            });
        });
    }

    _packageIntel(ip, obj, intel) {
        let weburl = "https://intel.firewalla.com/";
        log.info("IntelManger:PackageIntel:",ip,JSON.stringify(intel,null,2));
        if (intel == null) {
            return null;
        }
        if (intel.t) {
            obj.count = Math.abs(intel.t/10);  
        } else {
            obj.count = 4;
        }
        if (intel.s) {
            obj.severityscore = intel.s;
        } else {
            obj.severityscore = 20;
        }
        obj.summary = "";
        obj.weburl = weburl;
        if (intel.cc) {
            try {
                obj.tags = JSON.parse(intel.cc);
            } catch(e) {
            } 
        }
        log.info("IntelManger:PackageIntel:Done",ip,JSON.stringify(intel,null,2),JSON.stringify(obj,null,2));
        return obj;
    }

    
    _packageCymon(ip, obj) {
        let weburl = "https://cymon.io/" + ip;
        log.info("INFO:------ Intel Information", obj.count);
        
        let results = obj.results.filter(x => !IGNORED_TAGS.includes(x.tag));
        obj.count = results.length;
        let summary = obj.count + " reported this IP.\n";
       
        let tags = {};
        for (let r of obj.results) {
            if (r.tag) {
                if (tags[r.tag] == null) {
                    tags[r.tag] = {
                        tag: r.tag,
                        count: 1
                    };
                } else {
                    tags[r.tag].count += 1;
                }
            }
        }

        let tagArray = [], tagCount = 0, severity = 0;
        for (let i in tags) {
            let tag = tags[i];
            tagArray.push(tag);
            if (i.includes("malicious")) {
              severity += tag.count * 3;
            } else if (i.includes("malware")) {
              severity += tag.count * 3;
            } else if (i == "blacklist") {
              severity += tag.count * 3;
            } else {
              severity += 1;
            }
            tagCount += tag.count;
        }

        tagArray.sort((a, b) => b.count - a.count);

        obj.severityscore = severity;
        obj.summary = summary;
        obj.weburl = weburl;
        obj.tags = tagArray;
        
        if (obj.tags && obj.tags.length > 0) {
          const reasonize = (tag) => `${tag.tag} - ${Math.round(tag.count / tagCount * 100)}%`;
          let reason = "Possibility: ";
            let first = true;
            for (let tag of obj.tags) {
                if (first) {
                    reason += reasonize(tag);
                    first = false;
                } else {
                    reason += ", " + reasonize(tag);
                }
            }
            obj.reason = reason;
        }
    }

    /* curl ipinfo.io/98.124.243.43/
{
  "ip": "98.124.243.43",
  "hostname": "No Hostname",
  "city": "Kirkland",
  "region": "Washington",
  "country": "US",
  "loc": "47.6727,-122.1873",
  "org": "AS21740 eNom, Incorporated",
  "postal": "98033"
 */
    _location(ip, callback) {
      log.info("Looking up location:",ip);
      this.cachelookup(ip, "ipinfo", (err,data)=>{
        if (data!=null) {
            callback(null, JSON.parse(data));
            return;
        }
        let weburl = "https://ipinfo.io/" + ip;

        var options = {
            uri: weburl,
            method: 'GET',
            family: 4
            // Authorization: 'Token dc30fcd03eddbd95b90bacaea5e5a44b1b60d2f5',
        };

        request(options, (err, httpResponse, body) => {
            if (err != null) {
                let stack = new Error().stack;
                log.info("Error while requesting ", err, stack);
                callback(err, null, null);
                return;
            }
            if (httpResponse == null) {
                let stack = new Error().stack;
                log.info("Error while response ", err, stack);
                callback(500, null, null);
                return;
            }
            if (httpResponse.statusCode < 200 ||
                httpResponse.statusCode > 299) {
                log.error("**** Error while response HTTP ", httpResponse.statusCode);
                callback(httpResponse.statusCode, null, null);
                return;
            }
            if (err === null && body != null) {
                this.cacheAdd(ip, "ipinfo", body);
                let obj = JSON.parse(body);
                if (obj != null) {
                    callback(null,obj);
                } else {
                    callback(null,null);
                }
            }
        });
      });
    }

    _lookup(ip, intel, callback) {
        let url = "https://cymon.io/api/nexus/v1/ip/" + ip + "/events?limit=100";

        let options = {
            uri: url,
            method: 'GET',
            family: 4
        };

        this._location(ip, (err,lobj)=>{
            let obj = {lobj};
            log.info("Intel:Location",ip,lobj);
            obj = this._packageIntel(ip,obj,intel);
            request(options, (err, resp, body) => {
                if (err) {
                    log.info(`Error while requesting ${url}`, err);
                    callback(err, null, null);
                    return;
                }
                if (!resp) {
                    log.info("Error while response ", err);
                    callback(500, null, null);
                    return;
                }
                if (resp.statusCode < 200 || resp.statusCode > 299) {
                    log.error("**** Error while response HTTP ", resp.statusCode);
                    callback(resp.statusCode, null, null);
                    return;
                }
                if (body) {
                    this.cacheAdd(ip, "cymon", body);
                    let cobj = JSON.parse(body);
                    if (cobj) {
                        if (cobj.count === 0) {
                            log.info("INFO:====== No Intel Information!!", ip, obj);
                            callback(null,obj);
                        } else {
                            cobj.lobj = lobj;
                            this._packageCymon(ip, cobj);
                            callback(err, cobj, cobj.weburl);
                        }
                    } else {
                        callback(null,obj);
                    }
                } else {
                    callback(null,obj);
                }
            });
        });
    }
}
