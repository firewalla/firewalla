/*    Copyright 2019-2023 Firewalla Inc.
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

const log = require('../../net2/logger.js')(__filename);
const rclient = require('../../util/redis_manager.js').getRedisClient();
const sem = require('../../sensor/SensorEventManager.js').getInstance();
const useragent = require('useragent');
const firewalla = require('../../net2/Firewalla.js');

const HostTool = require('../../net2/HostTool.js');
const hostTool = new HostTool();
const IdentityManager = require('../../net2/IdentityManager.js');
const DNSTool = require('../../net2/DNSTool.js');
const dnsTool = new DNSTool();
const iptool = require('ip');
const {formulateHostname, isDomainValid} = require('../../util/util.js');

const sysManager = require('../../net2/SysManager.js');

const Getter = require('../../net2/config.js').Getter
const config = new Getter('bro')

const flowLink = require('./FlowLink.js');

const validator = require('validator');
const fs = require('fs')
const LRU = require('lru-cache');

const uaInfoCache = new LRU({max: 4096, maxAge: 96400 * 1000});

const KEY_UA_INFO_PREFIX = "info:user_agent:";
const UA_INFO_EXP = 86400;

let instance = null;

/*
{"ts":1506304095.747873,"uid":"CgTsJH3vHBNpMIREU9","id.orig_h":"192.168.2.227","id.orig_p":47292,"id.resp_h":"103.224.182.240","id.resp_p":80,"trans_depth":1,"method":"GET","host":"goooogleadsence.biz","uri":"/","user_agent":"Wget/1.16 (linux-gnueabihf)","request_body_len":0,"response_body_len":0,"status_code":302,"status_msg":"Found","tags":[]}
*/

class HttpFlow {
  constructor() {
    if (instance === null) {
      this.initDeviceDetector()

      sem.on('DeviceDetector:RegexUpdated', message => {
        this.initDeviceDetector()
      })

      instance = this;
    }
    return instance;
  }

  async initDeviceDetector() {
    const regexPath = firewalla.getRuntimeInfoFolder() + '/device-detector-regexes/'
    try {
      await fs.promises.access(regexPath, fs.constants.F_OK)
      if (!this.detector) {
        const DeviceDetector = require('../../vendor_lib/node-device-detector/')
        this.detector = new DeviceDetector({
          clientIndexes: true,
          deviceIndexes: true,
          deviceAliasCode: false,
          baseRegexDir: regexPath,
        })
        log.info('Device detector initialized')
      } else {
        this.detector.init({ baseRegexDir: regexPath })
        log.info('Device detector reinitialized')
      }
    } catch(err) {
      if (err.code == 'ENOENT')
        log.error('Regex folder not ready')
      else
        log.error('Error reading folder', err)
    }
  }

  async getUserAgentInfo(userAgent) {
    let result = uaInfoCache.peek(userAgent);
    if (!result) {
      result = {};
      try {
        const detectResult = this.detector.detect(userAgent);
        if (detectResult)
          result.detect = detectResult;
        const parseResult = useragent.parse(userAgent);
        if (parseResult)
          result.parse = parseResult;
        if (Object.keys(result) > 0)
          uaInfoCache.set(userAgent, result);
      } catch (err) {
        log.error(`Failed to detect user agent info of ${userAgent}`, err.message);
      }
    }
    return result;
  }

  async processUserAgent(mac, flowObject) {
    if (!this.detector)
      return;
    const info = await this.getUserAgentInfo(flowObject.user_agent);
    if (!info)
      return;
    const expireTime = config.get('userAgent.expires');
    const result = info.detect;

    if (result) {
      /* full result example
      {
        os: {
          name: 'Android',            // os name
          short_name: 'AND',          // os short code name (format A-Z0-9{3})
          version: '5.0',             // os version
          platform: '',               // os platform (x64, x32, amd etc.)
          family: 'Android'           // os family
        },
        client:  {
          type: 'browser',            // client type
          name: 'Chrome Mobile',      // client name name
          short_name: 'CM',           // client short code name (only browser, format A-Z0-9{2,3})
          version: '43.0.2357.78',    // client version
          engine: 'Blink',            // client engine name (only browser)
          engine_version: '',         // client engine version (only browser)
          family: 'Chrome'            // client family (only browser)
        },
        device: {
          id: 'ZT',                   // short code device brand name (format A-Z0-9{2,3})
          type: 'smartphone',         // device type
          brand: 'ZTE',               // device brand name
          model: 'Nubia Z7 max'       // device model name
          code: 'NX505J'              // device model code  (only result for enable detector.deviceAliasCode)
        }
      } */

      if (!result.os || !result.os.family) {
        delete result.os
      } else {
        result.os = { family: result.os.family }
      }
      if (!result.client || !result.client.type || !result.client.name) {
        delete result.client
      } else {
        result.client = {
          type: result.client.type,
          name: result.client.name,
        }
      }
      if (!result.device || !result.device.type || !result.device.brand) {
        delete result.device
      } else {
        delete result.device.id
        if (!result.device.type) delete result.device.type
        if (!result.device.brand) delete result.device.brand
        if (!result.device.model) delete result.device.model
      }

      result.ua = flowObject.user_agent
      
      try {
        const key = `host:user_agent2:${mac}`;
        await rclient.zaddAsync(key, Date.now() / 1000, JSON.stringify(result));
        await rclient.expireAsync(key, expireTime);
      } catch (err) {
        log.error(`Failed to save user agent info for mac ${mac}, err: ${err}`);
      }
    }

    const agent = info.parse;

    if (agent && agent.device && agent.device.family) {
      const key = `host:user_agent:${mac}`;
      const content = {
        'family': agent.device.family,
        'os': agent.os.toString(),
        'ua': flowObject.user_agent
      };

      try {
        await rclient.saddAsync(key, JSON.stringify(content));
        await rclient.expireAsync(key, expireTime);
      } catch (err) {
        log.error(`Failed to save user agent info for mac ${mac}, err: ${err}`);
      }
    }

    try {
      const srcIP = flowObject["id.orig_h"];
      const destIP = flowObject["id.resp_h"];
      const destPort = flowObject["id.resp_p"];
      const destExpireTime = config.get('activityUserAgent.expires')

      const destKey = `user_agent:${srcIP}:${destIP}:${destPort}`;
      await rclient.setAsync(destKey, flowObject.user_agent);
      await rclient.expireAsync(destKey, destExpireTime);
    } catch (err) {
      log.error(`Failed to save dest user agent info, err: ${err}`);
    }
  }

  async refreshDNSMapping(flowObject) {
    const destIP = flowObject["id.resp_h"];
    const host = flowObject.host;
    if (firewalla.isReservedBlockingIP(destIP)) {
      return;
    }

    // do not record if *host* is an IP
    if (validator.isIP(host)) {
      return;
    }

    if ((iptool.isV4Format(destIP) || iptool.isV6Format(destIP)) && isDomainValid(host)) {
      const domain = formulateHostname(host);
      await dnsTool.addDns(destIP, domain, config.get('dns.expires'));
      await dnsTool.addReverseDns(domain, [destIP], config.get('dns.expires'));
    }
  }

  async process(obj) {
    try {
      if (obj == null || !obj.uid) {
        log.error("HTTP:Drop", obj);
        return;
      }
      if (obj && obj.status_code != 200) {
        return;
      }

      const srcIP = obj["id.orig_h"];
      const destIP = obj["id.resp_h"];
      const host = obj.host;
      const uri = obj.uri;
      let localIP = null;
      let flowDirection = null;

      if (iptool.isPrivate(srcIP) && iptool.isPrivate(destIP))
        return;

      let intf = sysManager.getInterfaceViaIP(srcIP);
      if (intf) {
        flowDirection = "outbound";
        localIP = srcIP;
      } else {
        intf = sysManager.getInterfaceViaIP(destIP);
        if (intf) {
          flowDirection = "inbound";
          localIP = destIP;
        } else {
          log.error("HTTP:Error:Drop", obj);
          return;
        }
      }

      let mac = await hostTool.getMacByIPWithCache(localIP);
      if (!mac) {
        const identity = IdentityManager.getIdentityByIP(localIP);
        if (identity)
          mac = identity.getGUID();
      }
      if (!mac) {
        log.error(`No mac address found for ip ${localIP}, dropping http flow`);
        return;
      }

      if (obj.user_agent != null) {
        await this.processUserAgent(mac, obj);
      }

      if (host && uri) {
        sem.emitEvent({
          type: 'DestURLFound', // to have DestURLHook to get intel for this url
          url: `${host}${uri}`,
          mac: mac,
          suppressEventLogging: true
        });
      }

      const flowKey = `flow:http:${flowDirection}:${mac}`;
      const strdata = JSON.stringify(obj);
      const redisObj = [flowKey, obj.ts, strdata];
      log.debug("HTTP:Save", redisObj);

      try {
        const expireTime = config.get('http.expires')
        await rclient.zaddAsync(redisObj);
        await rclient.expireAsync(flowKey, expireTime);

        flowLink.recordHttp(obj.uid, obj.ts, { mac, flowDirection });
      } catch (err) {
        log.error(`Failed to save http flow, err: ${err}`);
      }

      /* this piece of code uses http to map dns */
      if (flowDirection === "outbound" && obj.host) {
        await this.refreshDNSMapping(obj);
      }
    } catch (e) {
      log.error("HTTP:Error Unable to save", obj, e);
    }
  }
}

module.exports = new HttpFlow();
