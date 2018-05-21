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

const Promise = require('bluebird');
const request = require('request');
const rp = require('request-promise');
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

    async cacheLookupAsync(ip, origin) {
      let result;
      
      let key = "cache.intel:" + origin + ":" + ip;
      
      try {
        result = await rclient.getAsync(key);
      } catch (err) {
        // null
      }
      
      if (result && (result === "{}" || Object.keys(result).length === 0)) {
        result = null;
      }
      
      log.info("Cache lookup for", ip, ", result:", result);
      return result;
    }

    cacheAdd(ip, origin, value) {
        if (value == null || value === "{}") {
            value = "none";
        }
        
        let key = "cache.intel:" + origin + ":" + ip;
        
        log.info("Add into cache.intel, key:", key, ", value:", value);
        
        rclient.set(key, value, (err, result) => {
          rclient.expireat(key, this.currentTime() + A_WEEK);
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

      log.info("FlowObj:", flowObj);

      let intel = flowObj.intel;

      if (!intel.category) {
        log.info("No intel for domain", domain, "look up from cloud...");
        intel = await this._lookupDomain(domain, ip);
      } else {
        log.info("Intel for domain", domain, " exists in flowObj");
        if (intel.cc) {
          try {
            intel.cc = JSON.parse(intel.cc)[0];
          } catch (err) {
            log.warn("Error when parsing info.cc:", intel.cc, err);
          }
        }
      }
      log.info(`Intel for domain ${domain} is`, intel);
  
      return intel;
    }
    
    async isIgnored(target) {
      let data = await rclient.hgetallAsync("intel:action:" + target);
      log.info("Ignore check for domain:", target, " is", data);
      return data && data.ignore;
    }
    
    async _lookupDomain(domain, ip) {
      let cloudIntel;
      try {
        cloudIntel = await intelTool.checkIntelFromCloud([ip], [domain], 'out');
      } catch (err) {
        log.info("Error when check intel from cloud", err);
      }
      log.info("Cloud intel for ", domain, "is: ", cloudIntel);

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

    async lookup(ip, intel) {
      if (!ip || ip === "8.8.8.8" || sysManager.isLocalIP(ip)) {
        return;
      }

      let data = await rclient.hgetallAsync("intel:action:" + ip);
      if (data && data.ignore) {
        log.info("Intel:Lookup:Ignored", ip);
        return;
      }

      let result = await this.cacheLookupAsync(ip, "cymon");
      if (result && result !== "none") {
        let lobj = await this._location(ip);
        let obj = JSON.parse(result);
        if (!obj || obj.count === 0) {
          obj = {}
          obj.lobj = lobj;
          obj = this._packageIntel(ip, obj, intel);
          return obj;
        } else {
          obj.lobj = lobj;
          log.info("Intel:Location", ip, obj.lobj);
          this._packageCymon(ip, obj);
          return obj;
        }
      } else {
        return await this._lookup(ip, intel);
      }
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
  async _location(ip) {
    log.info("Looking up location:", ip);

    let cached = await this.cacheLookupAsync(ip, "ipinfo");
    
    if (cached === "none") {
      return null;
    }

    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (err) {
        log.error("Error when parse cache:", cached, err);
      }
    }

    let ipinfo = await Promise.join(
      this._ipInfoFromBone(ip),
      this._ipInfoFromIpinfo(ip),
      (info1, info2) => Object.assign(info1 ? info1 : {}, info2)
      
    );
    
    log.info("Merged ipinfo is:", ipinfo);

    this.cacheAdd(ip, "ipinfo", JSON.stringify(ipinfo));
    
    return ipinfo;
  }

  async _ipInfoFromBone(ip) {
    let result = await bone.intelFinger(ip);
    if (result) {
      log.info("ipInfo from bone is:", result.ipinfo);
      return result.ipinfo;
    }
    log.info("ipInfo from bone is:", null);
    return null;
  }

  async _ipInfoFromIpinfo(ip) {
    const options = {
      uri: "https://ipinfo.io/" + ip,
      method: 'GET',
      family: 4,
      timeout: 6000, // ms
      // Authorization: 'Token dc30fcd03eddbd95b90bacaea5e5a44b1b60d2f5',
    };

    let body;
    let result = null;
    try {
      body = await rp(options);
    } catch (err) {
      log.error("Error while requesting", options.uri, err.code, err.message, err.stack);
      return null;
    }

    try {
      result = JSON.parse(body);
    } catch (err) {
      log.error("Error when parse body:", body, err);
    }

    log.info("ipInfo from ipinfo is:", result);
    return result;
  }

  async _lookup(ip, intel) {
    let url = "https://cymon.io/api/nexus/v1/ip/" + ip + "/events?limit=100";

    let options = {
      uri: url,
      method: 'GET',
      family: 4
    };

    let lobj = await this._location(ip);

    let obj = {lobj};
    log.info("Intel:Location", ip, lobj);
    obj = this._packageIntel(ip, obj, intel);

    let body;
    try {
      body = await rp(options);
    } catch (err) {
      log.info(`Error while requesting ${url}`, err.code, err.message, err.stack);
    }

    this.cacheAdd(ip, "cymon", body);
    
    let cobj = JSON.parse(body);
    if (cobj) {
      if (cobj.count === 0) {
        log.info("INFO:====== No Intel Information!!", ip, obj);
        return obj;
      } else {
        cobj.lobj = lobj;
        this._packageCymon(ip, cobj);
        return cobj;
      }
    } else {
      return obj;
    }
  }
}
