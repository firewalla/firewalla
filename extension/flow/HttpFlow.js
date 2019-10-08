/*    Copyright 2019 Firewalla INC
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
const DNSTool = require('../../net2/DNSTool.js');
const dnsTool = new DNSTool();

const SysManager = require('../../net2/SysManager.js');
const sysManager = new SysManager('info');

const config = require('../../net2/config.js').getConfig();

const flowLink = require('./FlowLink.js');

let instance = null;

/*
{"ts":1506304095.747873,"uid":"CgTsJH3vHBNpMIREU9","id.orig_h":"192.168.2.227","id.orig_p":47292,"id.resp_h":"103.224.182.240","id.resp_p":80,"trans_depth":1,"method":"GET","host":"goooogleadsence.biz","uri":"/","user_agent":"Wget/1.16 (linux-gnueabihf)","request_body_len":0,"response_body_len":0,"status_code":302,"status_msg":"Found","tags":[]}
*/

class HttpFlow {
  constructor() {
    if(instance === null) {
      instance = this;
    }
    return instance;
  }

  async processUserAgent(mac, flowObject) {
    const agent = useragent.parse(flowObject.user_agent);

    if(agent == null || agent.device == null || agent.device.family == null) {
      return;
    }

    const srcIP = flowObject["id.orig_h"];
    const destIP = flowObject["id.resp_h"];
    const destPort = flowObject["id.resp_p"];

    const key = `host:user_agent:${mac}`;

    const content = {
      'family': agent.device.family,
      'os': agent.os.toString(),
      'ua': flowObject.user_agent
    };

    try {
      const expireTime = (config && config.bro && config.bro.userAgent && config.bro.userAgent.expires) || 1800; // default 30 minutes

      await rclient.saddAsync(key, JSON.stringify(content));
      await rclient.expireAsync(key, expireTime);
    } catch(err) {
      log.error(`Failed to save user agent info for mac ${mac}, err: ${err}`);
    }

    try {
      const destExpireTime = (config && config.bro && config.bro.activityUserAgent && config.bro.activityUserAgent.expires) || 14400; // default 4 hours

      const destKey = `user_agent:${srcIP}:${destIP}:${destPort}`;
      await rclient.setAsync(destKey, flowObject.user_agent);
      await rclient.expireAsync(destKey, destExpireTime);
    } catch(err) {
      log.error(`Failed to save dest user agent info, err: ${err}`);
    }
  }

  async refreshDNSMapping(flowObject) {
    const destIP = flowObject["id.resp_h"];
    const host = flowObject.host;
    if (firewalla.isReservedBlockingIP(destIP)) {
      return;
    }
    await dnsTool.addDns(destIP, host, (config && config.bro && config.bro.dns && config.bro.dns.expires) || 100000);
  }

  async process(flow) {
    try {
      const obj = JSON.parse(flow);
      if (obj == null || !obj.uid) {
        log.error("HTTP:Drop", obj);
        return;
      }

      const srcIP = obj["id.orig_h"];
      const destIP = obj["id.resp_h"];
      const host = obj.host;
      const uri = obj.uri;
      let localIP = null;
      let flowDirection = null;

      if (sysManager.isLocalIP(srcIP)) {
        if (sysManager.isLocalIP(destIP)) {
          return; // ignore any local http traffic
        } else {
          flowDirection = "outbound";
          localIP = srcIP;
        }
      } else if (sysManager.isLocalIP(destIP)) {
        flowDirection = "inbound";
        localIP = destIP;
      } else {
        log.error("HTTP:Error:Drop", flow);
        return;
      }

      const mac = await hostTool.getMacByIPWithCache(localIP);
      if(!mac) {
        log.error(`No mac address found for ip ${localIP}, dropping http flow`);
        return;
      }

      if (obj.user_agent != null) {
        await this.processUserAgent(mac, obj);
      }

      if(host && uri) {
        sem.emitEvent({
          type: 'DestURLFound', // to have DestURLHook to get intel for this url
          url: `${host}${uri}`,
          suppressEventLogging: true
        });
      }

      const flowKey = `flow:http:${flowDirection}:${mac}`;
      const strdata = JSON.stringify(obj);
      const redisObj = [flowKey, obj.ts, strdata];
      log.debug("HTTP:Save", redisObj);

      try {
        const expireTime = (config && config.bro && config.bro.http && config.bro.http.expires) || 1800; // default 30 minutes
        await rclient.zaddAsync(redisObj);
        await rclient.expireAsync(flowKey, expireTime);

        flowLink.recordHttp(obj.uid, obj.ts, {mac, flowDirection});
      } catch(err) {
        log.error(`Failed to save http flow, err: ${err}`);
      }

      /* this piece of code uses http to map dns */
      if (flowDirection === "inbound" && obj.host) {
        await this.refreshDNSMapping(obj);
      }
    } catch (e) {
      log.error("HTTP:Error Unable to save", e, flow, e.stack, {});
    }
  }
}

module.exports = new HttpFlow();
