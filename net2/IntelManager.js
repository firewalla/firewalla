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

const rp = require('request-promise');
const SysManager = require('./SysManager.js');
const sysManager = new SysManager('info');

const rclient = require('../util/redis_manager.js').getRedisClient()

const bone = require("../lib/Bone.js");
const IntelTool = require('./IntelTool');
const intelTool = new IntelTool();

const Whois = require('../util/Whois');
const IpInfo = require('../util/IpInfo');

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
      rclient.hmset("intel:action:" + ip, {'ignore': true}, (err) => {
        callback(err, null);
      });
    } else if (action === "unignore") {
      rclient.hmset("intel:action:" + ip, {'ignore': false}, (err) => {
        callback(err, null);
      });
    } else if (action === "block") {
    } else if (action === "unblock") {
    } else if (action === "support") {
    }

    bone.intel(ip, "", action, {});
  }

  async cacheLookup(ip, origin) {
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

    log.info("Cache lookup for", ip, ", origin", origin, ", result:", result);
    return result;
  }

  async cacheAdd(ip, origin, value) {
    if (value == null || value === "{}") {
      value = "none";
    }

    let key = "cache.intel:" + origin + ":" + ip;

    log.info("Add into cache.intel, key:", key, ", value:", value);

    return rclient.setAsync(key, value)
      .then(result => rclient.expireatAsync(key, this.currentTime() + A_WEEK))
      .catch(err => {
        log.warn(`Error when add ip ${ip} from ${origin} to cache`, err);
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

    log.debug("FlowObj:", flowObj);

    let intelObj = flowObj.intel;

    if (!intelObj.category) {
      log.info("No intel for domain", domain, "look up from cloud...");
      intelObj = await this._lookupDomainInBone(domain, ip);
    } else {
      log.info("Intel for domain", domain, " exists in flowObj");
      if (intelObj.cc) {
        try {
          let json = JSON.parse(intelObj.cc)
          if(Array.isArray(json)) {
            // HACK, excluding attackpage
            json = json.filter(x => x !== "attackpage")
            intel.cc = json[0]
          }
        } catch (err) {
          log.warn("Error when parsing info.cc:", intelObj.cc, err);
        }
      }
    }

    if (!intelObj.lobj) {
      intelObj.lobj = await this.ipinfo(ip);
    }

    if (!intelObj.whois) {
      intelObj.whois = await this.whois(domain);
    }

    log.info(`Intel for domain ${domain} is`, intelObj);

    return intelObj;
  }

  async lookupIp(ip, flowIntel) {
    if (!ip || ip === "8.8.8.8" || sysManager.isLocalIP(ip)) {
      return;
    }

    let data = await rclient.hgetallAsync("intel:action:" + ip);
    if (data && data.ignore) {
      log.info("Intel:Lookup:Ignored", ip);
      return;
    }

    let [intelObj, ipinfo, whois] = await Promise.all([this.cymon(ip), this.ipinfo(ip), this.whois(ip)]);
    
    if (!intelObj) {
      intelObj = {};
    } else {
      intelObj.whois = whois;
      intelObj = this.addFlowIntel(ip, intelObj, flowIntel);
      intelObj = this.summarizeIntelObj(ip, intelObj);  
    }

    log.info("Ipinfo:", ipinfo);
    intelObj.lobj = ipinfo;

    log.info("IntelObj:", intelObj);

    return intelObj;
  }

  async whois(target) {
    log.info("Looking whois:", target);

    let cached = await this.cacheLookup(target, "whois");

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

    let whois = await Whois.lookup(target, {useOwnParser: true});

    if (whois) {
      this.cacheAdd(target, "whois", JSON.stringify(whois));
    }

    return whois;
  }

  async isIgnored(target) {
    let data = await rclient.hgetallAsync("intel:action:" + target);
    log.info("Ignore check for domain:", target, " is", data);
    return data && data.ignore;
  }

  async _lookupDomainInBone(domain, ip) {
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

  addFlowIntel(ip, intelObj, intel) {
    let weburl = "https://intel.firewalla.com/";
    log.info("IntelManger:addFlowIntel:", ip, intel);
    if (intel == null) {
      return null;
    }
    if (intel.t) {
      intelObj.count = Math.abs(intel.t / 10);
    } else {
      intelObj.count = 4;
    }
    if (intel.s) {
      intelObj.severityscore = intel.s;
    } else {
      intelObj.severityscore = 20;
    }
    intelObj.summary = "";
    intelObj.weburl = weburl;
    if (intel.cc) {
      try {
        intelObj.tags = JSON.parse(intel.cc);
      } catch (e) {
      }
    }
    log.info("IntelManger:addFlowIntel:Done", ip);
    return intelObj;
  }

  summarizeIntelObj(ip, intelObj) {
    let weburl = "https://cymon.io/" + ip;
    log.info("INFO:------ Intel Information", intelObj.count);

    let results = intelObj.results.filter(x => !IGNORED_TAGS.includes(x.tag));
    intelObj.count = results.length;
    let summary = intelObj.count + " reported this IP.\n";

    let tags = {};
    for (let r of intelObj.results) {
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

    intelObj.severityscore = severity;
    intelObj.summary = summary;
    intelObj.weburl = weburl;
    intelObj.tags = tagArray;

    if (intelObj.tags && intelObj.tags.length > 0) {
      const reasonize = (tag) => `${tag.tag} - ${Math.round(tag.count / tagCount * 100)}%`;
      let reason = "Possibility: ";
      let first = true;
      for (let tag of intelObj.tags) {
        if (first) {
          reason += reasonize(tag);
          first = false;
        } else {
          reason += ", " + reasonize(tag);
        }
      }
      intelObj.reason = reason;
    }
    return intelObj;
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
  }
  */
  async ipinfo(ip) {
    log.info("Looking up location:", ip);

    let cached = await this.cacheLookup(ip, "ipinfo");

    if (cached === "none") {
      return null;
    }

    let ipinfo;
    if (cached && cached !== 'null') {
      try {
        ipinfo = JSON.parse(cached);
      } catch (err) {
        log.error("Error when parse cache:", cached, err);
      }
      if (ipinfo) {
        return ipinfo;
      }
    }

    ipinfo = await IpInfo.get(ip);

    if (ipinfo) {
      this.cacheAdd(ip, "ipinfo", JSON.stringify(ipinfo));
    }

    log.info("Ipinfo is:", ipinfo);

    return ipinfo;
  }
  
  async cymon(ip) {
    log.info("Looking up cymon:", ip);

    let cached = await this.cacheLookup(ip, "cymon");

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
    
    let body;
    try {
      body = await rp({
        uri: "https://cymon.io/api/nexus/v1/ip/" + ip + "/events?limit=100",
        method: 'GET',
        family: 4,
        json: true,
        timeout: 10000 //ms
      });
    } catch (err) {
      log.info(`Error while requesting ${url}`, err.code, err.message, err.stack);
    }
    this.cacheAdd(ip, "cymon", JSON.stringify(body));
    return body;
  }
  
}
