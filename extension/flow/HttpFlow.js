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

const uaInfoCache = new LRU({max: 4096, maxAge: 86400 * 1000});

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
        uaInfoCache.reset()
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
          skipBotDetection: true,
          skipClientDetection: true,
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

  async processUserAgent(mac, flowObject) {
    const userAgent = flowObject.user_agent
    const expireTime = config.get('userAgent.expires');
    const key2 = `host:user_agent2:${mac}`;

    const cachedStr = uaInfoCache.get(userAgent);
    if (cachedStr) {
      log.debug('Found in LRU', mac, userAgent)
      await rclient.zaddAsync(key2, Date.now() / 1000, cachedStr);
      await rclient.expireAsync(key2, expireTime);
      return
    }

    if (this.detector) {
      const result = this.detector.detect(userAgent)
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
        result.os = { family: result.os.family, name: result.os.name }
      }
      delete result.client
      if (!Object.keys(result.device).length) {
        delete result.device
      } else {
        delete result.device.id
        if (!result.device.type) delete result.device.type
        if (!result.device.brand) delete result.device.brand
        if (!result.device.model) delete result.device.model
      }

      result.ua = flowObject.user_agent

      const resultStr = JSON.stringify(result)
      try {
        await rclient.zaddAsync(key2, Date.now() / 1000, resultStr);
        await rclient.expireAsync(key2, expireTime);
      } catch (err) {
        log.error(`Failed to save user agent info for mac ${mac}, err: ${err}`);
      }

      uaInfoCache.set(userAgent, resultStr);
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

      const srcIP = obj["id.orig_h"];
      const destIP = obj["id.resp_h"];
      const host = obj.host;
      const uri = obj.uri;
      let localIP, remoteIP, remotePort, flowDirection

      if (iptool.isPrivate(srcIP) && iptool.isPrivate(destIP))
        return;

      let intf = sysManager.getInterfaceViaIP(srcIP);
      if (intf) {
        flowDirection = "outbound";
        localIP = srcIP;
        remoteIP = destIP
        remotePort = obj['id.resp_p']
      } else {
        intf = sysManager.getInterfaceViaIP(destIP);
        if (intf) {
          flowDirection = "inbound";
          localIP = destIP;
          remoteIP = srcIP
          remotePort = obj['id.orig_p']
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

        // this is for adding user_agent info to alarms, alarm doesn't have device port info
        try {
          const destExpireTime = config.get('activityUserAgent.expires')

          const destKey = `user_agent:${localIP}:${remoteIP}:${remotePort}`;
          await rclient.setAsync(destKey, obj.user_agent);
          await rclient.expireAsync(destKey, destExpireTime);
        } catch (err) {
          log.error(`Failed to save dest user agent info, err: ${err}`);
        }
      }


      const code = obj.status_code
      if (host && uri && code && code < 400) {
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
