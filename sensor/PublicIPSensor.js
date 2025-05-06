/*    Copyright 2016-2025 Firewalla Inc.
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
const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const sem = require('../sensor/SensorEventManager.js').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()
const Message = require('../net2/Message.js');
const sysManager = require('../net2/SysManager.js');

const exec = require('child-process-promise').exec;

const { rrWithErrHandling } = require('../util/requestWrapper.js')

const redisKey = "sys:network:info";
const redisHashKey = "publicIp";
const redisHashKey6 = "publicIp6s";
const publicWanIPsHashKey = "publicWanIps";
const publicIPsHashKey = "publicIps";
const extensionManager = require('./ExtensionManager.js');
const policyKeyName = "ddns";
const f = require('../net2/Firewalla.js');

const _ = require('lodash');
const { Address4 } = require('ip-address');

class PublicIPSensor extends Sensor {
  async job() {
    try {
      let intf = null;
      let bindIP = null;
      let publicIP6s = [];
      if (this.wanIP) {
        intf = sysManager.getWanInterfaces().find(iface => iface && _.isArray(iface.ip4_addresses) && iface.ip4_addresses.includes(this.wanIP))
        if (!intf)
          log.error(`WAN interface with IP address ${this.wanIP} does not exist currently`);
        else
          bindIP = this.wanIP;
      } else {
        if (this.wanUUID) {
          intf = sysManager.getWanInterfaces().find(iface => iface && iface.uuid === this.wanUUID);
          if (!intf)
            log.error(`WAN interface with uuid ${this.wanUUID} does not exist currently`);
          else
            bindIP = intf && !_.isEmpty(intf.ip4_addresses) && intf.ip4_addresses[0];
        }
      }
      if (intf) {
        if (!bindIP)
          log.error(`WAN interface ${intf.name} does not have an IPv4 address to bind`);
        else {
          log.info(`Public IP discovery requests will be bound to WAN IP ${bindIP} on ${intf.name}`);
          publicIP6s = intf && _.isArray(intf.ip6_addresses) && sysManager.filterPublicIp6(intf.ip6_addresses).sort() || [];
        }
      } else {
        const defaultWanIntf = sysManager.getDefaultWanInterface();
        bindIP = defaultWanIntf && !_.isEmpty(defaultWanIntf.ip4_addresses) && defaultWanIntf.ip4_addresses[0];
        if (bindIP)
          log.info(`Public IP discovery requests will be bound to default WAN IP ${bindIP} on ${defaultWanIntf.name}`);
        publicIP6s = defaultWanIntf && _.isArray(defaultWanIntf.ip6_addresses) && sysManager.filterPublicIp6(defaultWanIntf.ip6_addresses).sort() || [];
      }
      let publicIP = null;
      if (bindIP || !intf) // if intf is found but cannot find an ip address to bind, publicIP should be simply null
        publicIP = await this._discoverPublicIP(bindIP);
      if (!publicIP && bindIP && sysManager.filterPublicIp4([bindIP]).length != 0) {
        log.info(`use bind IP ${bindIP} as the public IP tentatively`)
        publicIP = bindIP;
      }
      if (publicIP)
        log.info(`Discovered overall public IP: ${publicIP}`);
      else
        log.error(`Cannot discover overall public IP`);


      const publicIPs = {};
      for (const iface of sysManager.getWanInterfaces()) {
        const ipv4 = iface && !_.isEmpty(iface.ip4_addresses) && iface.ip4_addresses[0];
        if (ipv4) {
          const wanPublicIP = await this._discoverPublicIP(ipv4);
          if (wanPublicIP) {
            log.info(`Discovered public IP ${wanPublicIP} on wan interface ${iface.name}`);
            publicIPs[iface.name] = wanPublicIP;
          } else {
            log.error(`Cannot discover public IP on wan interface ${iface.name}`);
          }
        }
      }

      // TODO: support v6
      const publicWanIps = sysManager.filterPublicIp4(sysManager.myWanIps(true).v4).sort();
      // connected public WAN IP overrides public IP from http request, this is mainly used in load-balance mode
      if (publicWanIps.length > 0) {
        // do not override public IP if dns/http request is bound to a specific WAN
        if (!intf && !publicIP) {
          publicIP = publicWanIps[0];
        }
      }

      const existingPublicIP = await rclient.hgetAsync(redisKey, redisHashKey).then(result => result && JSON.parse(result)).catch((err) => null);
      const existingPublicWanIps = await rclient.hgetAsync(redisKey, publicWanIPsHashKey).then(result => result && JSON.parse(result)).then(result => _.isArray(result) && result.sort() || []).catch((err) => []);
      const existingPublicIP6s = await rclient.hgetAsync(redisKey, redisHashKey6).then(result => result && JSON.parse(result)).catch((err) => null);
      const existingPublicIPs = await rclient.hgetAsync(redisKey, publicIPsHashKey).then(result => result && JSON.parse(result)).catch((err) => null);
      if(publicIP !== existingPublicIP || !_.isEqual(publicWanIps, existingPublicWanIps) || !_.isEqual(publicIP6s, existingPublicIP6s) || !_.isEqual(publicIPs, existingPublicIPs)) {
        await rclient.hsetAsync(redisKey, redisHashKey, JSON.stringify(publicIP));
        await rclient.hsetAsync(redisKey, redisHashKey6, JSON.stringify(publicIP6s));
        await rclient.hsetAsync(redisKey, publicWanIPsHashKey, JSON.stringify(publicWanIps));
        await rclient.hsetAsync(redisKey, publicIPsHashKey, JSON.stringify(publicIPs));
        sem.emitEvent({
          type: "PublicIP:Updated",
          ip: publicIP,
          ip6s: publicIP6s,
          wanIPs: publicIPs
        }); // local event within FireMain
        sem.emitEvent({
          type: "PublicIP:Updated",
          ip: publicIP,
          ip6s: publicIP6s,
          wanIPs: publicIPs,
          toProcess: 'FireApi'
        });
      }
    } catch(err) {
      log.error("Failed to query public ip:", err);
    }
  }

  async _discoverPublicIP(localIP) {
    // use SIGKILL to kill the process on timeout, on Ubuntu 22, dig will hang in some cases and only SIGKILL can kill it
    let publicIP = await exec(`timeout -s 9 10 dig +short +time=3 +tries=2 ${localIP ? `-b ${localIP}` : ""} @resolver1.opendns.com myip.opendns.com`).then(result => result.stdout.trim()).catch((err) => null);
    if (publicIP && new Address4(publicIP).isValid())
      return publicIP;
    const publicIPApis = [
      {
        url: "https://api.ipify.org?format=json",
        followRedirect: false,
        cb: (result) => {
          if (result.body && result.body.ip)
            return result.body.ip;
          return null;
        }
      },
      {
        url: "https://ipinfo.io",
        followRedirect: false,
        cb: (result) => {
          if (result.body && result.body.ip)
            return result.body.ip;
          return null;
        }
      }
    ];
    for (const api of publicIPApis) {
      try {
        const options = {
          uri: api.url,
          json: true,
          maxAttempts: 2
        };
        if (localIP)
          options["localAddress"] = localIP;
        const result = await rrWithErrHandling(options);
        publicIP = api.cb(result);
        if (publicIP)
          return publicIP;
      } catch (err) {
        log.error("Failed to discover public ip, err:", err);
      }
    }
    return null;
  }

  async applyPolicy(host, ip, policy) {
    if (ip !== "0.0.0.0") {
      log.error("ddns policy is only supported on global level");
      return;
    }
    if (policy && policy.wanUUID)
      this.wanUUID = policy.wanUUID;
    else
      this.wanUUID = null;
    // in case there are multiple WAN IP addresses, user can specify a specific IP
    if (policy && policy.wanIP)
      this.wanIP = policy.wanIP;
    else
      this.wanIP = null;
    this.scheduleRunJob(true);
  }

  async run() {
    await sysManager.waitTillInitialized();
    this.scheduleRunJob();

    sem.on("PublicIP:Check", (event) => {
      this.job().finally(() => {
        sem.sendEventToFireApi({
          type: "PublicIP:Check:Complete",
          message: ""
        });
      });
    });

    if (f.isMain()) {
      extensionManager.registerExtension(policyKeyName, this, {
        applyPolicy: this.applyPolicy
      });
    }

    setInterval(() => {
      this.scheduleRunJob();
    }, this.config.interval * 1000 || 1000 * 60 * 60 * 2); // check every 2 hrs

    sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
      log.info("Schedule reload PublicIPSensor since network info is reloaded");
      this.scheduleRunJob();
    })
  }

  scheduleRunJob(recheckinNeeded = false) {
    if (this.reloadTask)
      clearTimeout(this.reloadTask);
    this.reloadTask = setTimeout(() => {
      this.job().then(() => {
        if (recheckinNeeded) {
          log.info("ddns policy is applied, trigger immediate cloud re-checkin ...")
          sem.emitEvent({
            type: "CloudReCheckin"
          });
        }
      });
    }, 5000);
  }
}

module.exports = PublicIPSensor;
