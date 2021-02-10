/*    Copyright 2020 Firewalla Inc
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

const log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient();
const PolicyManager = require('./PolicyManager.js');
const pm = new PolicyManager();
const f = require('./Firewalla.js');
const exec = require('child-process-promise').exec;
const { Address4, Address6 } = require('ip-address');

const vpnClientEnforcer = require('../extension/vpnclient/VPNClientEnforcer.js');
const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');
const routing = require('../extension/routing/routing.js');

const fs = require('fs');
const Promise = require('bluebird');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();
const ipset = require('./Ipset.js');
const _ = require('lodash');
Promise.promisifyAll(fs);

const envCreatedMap = {};

class VPNProfile {
  constructor(o) {
    this.o = o;
    this._policy = {};
    const c = require('./MessageBus.js');
    this.subscriber = new c('info');
    if (f.isMain()) {
      this.monitoring = false;
      if (o && o.cn) {
        this.subscriber.subscribeOnce("DiscoveryEvent", "VPNProfilePolicy:Changed", this.o.cn, (channel, type, id, obj) => {
          log.info(`VPN profile policy is changed on ${this.o.cn}`, obj);
          this.scheduleApplyPolicy();
        })
      }
    }
  }

  update(o) {
    this.o = o;
  }

  _getPolicyKey() {
    return `policy:vpn_profile:${this.o.cn}`;
  }

  toJson() {
    const json = Object.assign({}, this.o, {policy: this._policy});
    return json;
  }

  scheduleApplyPolicy() {
    if (this.applyPolicyTask)
      clearTimeout(this.applyPolicyTask);
    this.applyPolicyTask = setTimeout(() => {
      this.applyPolicy();
    }, 3000);
  }

  async applyPolicy() {
    await this.loadPolicy();
    const policy = JSON.parse(JSON.stringify(this._policy));
    await pm.executeAsync(this, this.o.cn, policy);
  }

  async loadPolicy() {
    const key = this._getPolicyKey();
    const policyData = await rclient.hgetallAsync(key);
    if (policyData) {
      this._policy = {};
      for (let k in policyData) {
        this._policy[k] = JSON.parse(policyData[k]);
      }
    } else {
      this._policy = {};
    }
    return this._policy;
  }

  async savePolicy() {
    const key = this._getPolicyKey();
    const policyObj = {};
    for (let k in this._policy) {
      policyObj[k] = JSON.stringify(this._policy[k]);
    }
    await rclient.hmsetAsync(key, policyObj).catch((err) => {
      log.error(`Failed to save policy to ${key}`, err);
    })
  }

  async setPolicy(name, data) {
    this._policy[name] = data;
    await this.savePolicy();
    if (this.subscriber) {
      this.subscriber.publish("DiscoveryEvent", "VPNProfilePolicy:Changed", this.o.cn, {name, data});
    }
  }

  static getVPNProfileSetName(cn, af = 4) {
    return `c_vpn_prof_${cn.substring(0, 12)}_set` + (af === 4 ? "" : "6");
  }

  static async ensureCreateEnforcementEnv(cn) {
    if (envCreatedMap[cn])
      return;
    // create related ipsets
    await exec(`sudo ipset create -! ${VPNProfile.getVPNProfileSetName(cn)} hash:net`).catch((err) => {
      log.error(`Failed to create VPN profile ipset ${VPNProfile.getVPNProfileSetName(cn)}`, err.message);
    });
    await exec(`sudo ipset create -! ${VPNProfile.getVPNProfileSetName(cn, 6)} hash:net family inet6`).catch((err) => {
      log.error(`Failed to create VPN profile ipset ${VPNProfile.getVPNProfileSetName(cn, 6)}`, err.message);
    });
    envCreatedMap[cn] = 1;
  }

  async createEnv() {
    await VPNProfile.ensureCreateEnforcementEnv(this.o.cn);
  }

  async destroyEnv() {
    await exec(`sudo ipset flush -! ${VPNProfile.getVPNProfileSetName(this.o.cn)}`).catch((err) => {
      log.error(`Failed to flush VPN profile ipset ${VPNProfile.getVPNProfileSetName(this.o.cn)}`, err.message);
    });
    await exec(`sudo ipset flush -! ${VPNProfile.getVPNProfileSetName(this.o.cn, 6)}`).catch((err) => {
      log.error(`Failed to flush VPN profile ipset ${VPNProfile.getVPNProfileSetName(this.o.cn, 6)}`, err.message);
    });
    // delete related dnsmasq config files
    await exec(`sudo rm -f ${f.getUserConfigFolder()}/dnsmasq/vpn_prof_${this.o.cn}.conf`).catch((err) => {});
    await exec(`sudo rm -f ${f.getUserConfigFolder()}/dnsmasq/vpn_prof_${this.o.cn}_*.conf`).catch((err) => {});
    dnsmasq.scheduleRestartDNSService();
  }

  async updateClientIPs(clientIPs) {
    if (this._clientIPs && _.isEqual(clientIPs.sort(), this._clientIPs.sort())) {
      log.info(`Client IP addresses of ${this.o.cn} is not changed`, clientIPs);
      return;
    }
    log.info(`Client IP addresses of ${this.o.cn} is changed`, this._clientIPs, clientIPs);
    await exec(`sudo ipset flush ${VPNProfile.getVPNProfileSetName(this.o.cn)}`).catch((err) => {
      log.error(`Failed to flush ${VPNProfile.getVPNProfileSetName(this.o.cn)}`, err.message);
    });
    await exec(`sudo ipset flush ${VPNProfile.getVPNProfileSetName(this.o.cn, 6)}`).catch((err) => {
      log.error(`Failed to flush ${VPNProfile.getVPNProfileSetName(this.o.cn, 6)}`, err.message);
    });
    const cmds = [];
    for (const ip of clientIPs) {
      if (new Address4(ip).isValid()) {
        cmds.push(`add ${VPNProfile.getVPNProfileSetName(this.o.cn)} ${ip}`);
      } else {
        if (new Address6(ip).isValid()) {
          cmds.push(`add ${VPNProfile.getVPNProfileSetName(this.o.cn, 6)} ${ip}`);
        }
      }
    }
    await ipset.batchOp(cmds).catch((err) => {
      log.error(`Failed to populate client ipset of ${this.o.cn}`, err.message);
    });
    // update dnsmasq config file
    // TODO: only supports IPv4 address here
    const entries = clientIPs.filter(ip => !ip.includes('/')).map(ip => `src-address-group=%${ip}@${this.o.cn}`);
    await fs.writeFileAsync(`${f.getUserConfigFolder()}/dnsmasq/vpn_prof_${this.o.cn}.conf`, entries.join('\n'), {encoding: 'utf8'});
    this._clientIPs = clientIPs;
    dnsmasq.scheduleRestartDNSService();
  }

  async spoof(state) {
    this.monitoring = state;
  }

  isMonitoring() {
    return this.monitoring;
  }

  async qos(state) {
    const profileIpsetName = VPNProfile.getVPNProfileSetName(this.o.cn);
    const profileIpsetName6 = VPNProfile.getVPNProfileSetName(this.o.cn, 6);
    if (state === true) {  
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${profileIpsetName}`).catch((err) => {
        log.error(`Failed to remove ${profileIpsetName} from ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${profileIpsetName6}`).catch((err) => {
        log.error(`Failed to remove ${profileIpsetName6} from ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
    } else {
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${profileIpsetName}`).catch((err) => {
        log.error(`Failed to add ${profileIpsetName} to ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${profileIpsetName6}`).catch((err) => {
        log.error(`Failed to add ${profileIpsetName6} to ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
    }
  }

  async acl(state) {
    const profileIpsetName = VPNProfile.getVPNProfileSetName(this.o.cn);
    const profileIpsetName6 = VPNProfile.getVPNProfileSetName(this.o.cn, 6);
    if (state === true) {  
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${profileIpsetName}`).catch((err) => {
        log.error(`Failed to remove ${profileIpsetName} from ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${profileIpsetName6}`).catch((err) => {
        log.error(`Failed to remove ${profileIpsetName6} from ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
    } else {
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${profileIpsetName}`).catch((err) => {
        log.error(`Failed to add ${profileIpsetName} to ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${profileIpsetName6}`).catch((err) => {
        log.error(`Failed to add ${profileIpsetName6} to ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
    }
  }

  async vpnClient(policy) {
    try {
      const state = policy.state;
      const profileId = policy.profileId;
      if (!profileId) {
        log.warn("VPN client profileId is not specified for " + this.o.cn);
        return false;
      }
      const ovpnClient = new OpenVPNClient({profileId: profileId});
      const intf = ovpnClient.getInterfaceName();
      const rtId = await vpnClientEnforcer.getRtId(intf);
      if (!rtId)
        return false;
      const rtIdHex = Number(rtId).toString(16);
      if (state === true) {
        // set skbmark
        await exec(`sudo ipset -! del c_vpn_client_tag_m_set ${VPNProfile.getVPNProfileSetName(this.o.cn)}`);
        await exec(`sudo ipset -! add c_vpn_client_tag_m_set ${VPNProfile.getVPNProfileSetName(this.o.cn)} skbmark 0x${rtIdHex}/${routing.MASK_VC}`);
        await exec(`sudo ipset -! del c_vpn_client_tag_m_set ${VPNProfile.getVPNProfileSetName(this.o.cn, 6)}`);
        await exec(`sudo ipset -! add c_vpn_client_tag_m_set ${VPNProfile.getVPNProfileSetName(this.o.cn, 6)} skbmark 0x${rtIdHex}/${routing.MASK_VC}`);
      }
      // null means off
      if (state === null) {
        // clear skbmark
        await exec(`sudo ipset -! del c_vpn_client_tag_m_set ${VPNProfile.getVPNProfileSetName(this.o.cn)}`);
        await exec(`sudo ipset -! add c_vpn_client_tag_m_set ${VPNProfile.getVPNProfileSetName(this.o.cn)} skbmark 0x0000/${routing.MASK_VC}`);
        await exec(`sudo ipset -! del c_vpn_client_tag_m_set ${VPNProfile.getVPNProfileSetName(this.o.cn, 6)}`);
        await exec(`sudo ipset -! add c_vpn_client_tag_m_set ${VPNProfile.getVPNProfileSetName(this.o.cn, 6)} skbmark 0x0000/${routing.MASK_VC}`);
      }
      // false means N/A
      if (state === false) {
        // do not change skbmark
        await exec(`sudo ipset -! del c_vpn_client_tag_m_set ${VPNProfile.getVPNProfileSetName(this.o.cn)}`);
        await exec(`sudo ipset -! del c_vpn_client_tag_m_set ${VPNProfile.getVPNProfileSetName(this.o.cn, 6)}`);
      }
      return true;
    } catch (err) {
      log.error("Failed to set VPN client access on " + this.o.cn);
      return false;
    }
  }

  async _dnsmasq(policy) {
    const dnsCaching = policy.dnsCaching;
    const profileIpsetName = VPNProfile.getVPNProfileSetName(this.o.cn);
    const profileIpsetName6 = VPNProfile.getVPNProfileSetName(this.o.cn, 6);
    if (dnsCaching === true) {
      let cmd =  `sudo ipset del -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${profileIpsetName}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to enable dns cache on ${profileIpsetName} ${this.o.intf}`, err);
      });
      cmd = `sudo ipset del -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${profileIpsetName6}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to enable dns cache on ${profileIpsetName6} ${this.o.intf}`, err);
      });
    } else {
      let cmd =  `sudo ipset add -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${profileIpsetName}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to disable dns cache on ${profileIpsetName} ${this.o.intf}`, err);
      });
      cmd = `sudo ipset add -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${profileIpsetName6}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to disable dns cache on ${profileIpsetName6} ${this.o.intf}`, err);
      });
    }
  }
}

module.exports = VPNProfile;