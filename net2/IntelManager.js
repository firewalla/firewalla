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

const sysManager = require('./SysManager.js');

const rclient = require('../util/redis_manager.js').getRedisClient()

const IntelTool = require('./IntelTool');
const intelTool = new IntelTool();

const Whois = require('../util/Whois');
const IpInfo = require('../util/IpInfo');

const A_DAY = 3600 * 24;

/* malware, botnet, spam, phishing, malicious activity, blacklist, dnsbl */
const IGNORED_TAGS = ['dnsbl', 'spam'];

module.exports = class {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    return instance;
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

    log.debug("Cache lookup for", ip, ", origin", origin, ", result:", result);
    return result;
  }

  async cacheAdd(ip, origin, value) {
    if (value == null || value === "{}") {
      value = "none";
    }

    let key = "cache.intel:" + origin + ":" + ip;

    log.debug("Add into cache.intel, key:", key, ", value:", value);

    try {
      await rclient.setAsync(key, value)
      await rclient.expireatAsync(key, this.currentTime() + A_DAY)
    } catch(err) {
      log.warn(`Error when add ip ${ip} from ${origin} to cache`, err);
    }
  }

  currentTime() {
    return Math.round(Date.now() / 1000);
  }

  async lookupDomain(domain, ip, flowObj) {
    if (!domain || domain === "firewalla.com") {
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
            intelObj.cc = json[0]
          }
        } catch (err) {
          log.warn("Error when parsing info.cc:", intelObj.cc, err);
        }
      }
    }

    if(intelObj.category === 'intel' && intelObj.s && Number(intelObj.s) === 0) {
      log.info("Intel ignored, severity score is zero", intelObj);
      return;
    }

    if (!intelObj.whois) {
      intelObj.whois = await this.whois(domain);
    }

    intelObj.from = "firewalla";

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

    let intelObj = this.addFlowIntel(ip, {}, flowIntel);

    log.debug("IntelObj:", intelObj);

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

  async _lookupDomainInBone(domain, ip) {
    let cloudIntel;
    try {
      // TODO: save this to intel:ip
      cloudIntel = await intelTool.checkIntelFromCloud([ip], [domain], {fd: 'out'});
    } catch (err) {
      log.info("Error when check intel from cloud", err);
    }
    log.info("Cloud intel for ", domain, "is: ", cloudIntel);

    return this.processCloudIntel(cloudIntel[0]);
  }

  // TODO: we should unify those intel keys (both on cloud and box)
  // so far it doesn't seem to be very useful to box right now
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
    log.debug("IntelManger:addFlowIntel:", ip, intel);
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
    intelObj.from = "firewalla";
    if (intel.cc) {
      try {
        intelObj.category = JSON.parse(intel.cc);
      } catch (e) {
      }
    }
    log.debug("IntelManger:addFlowIntel:Done", ip);
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
  async ipinfo(ip, lookupCacheOnly = false) {
    log.debug("Looking up location:", ip);

    let cached = await this.cacheLookup(ip, "ipinfo");

    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.country) {
          log.debug("Cached ip info:", ip);
          return parsed;
        }
      } catch (err) {
        log.error("Error when parse cache:", cached, err);
      }
    }

    if (lookupCacheOnly)
      return null;

    const ipinfo = await IpInfo.get(ip);

    if (ipinfo) {
      this.cacheAdd(ip, "ipinfo", JSON.stringify(ipinfo));
    }

    return ipinfo;
  }
}
