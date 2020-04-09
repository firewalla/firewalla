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
const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');
const vpnClientEnforcer = require('../extension/vpnclient/VPNClientEnforcer.js');
const {Rule, wrapIptables} = require('./Iptables.js');
const fs = require('fs');
const Promise = require('bluebird');
const ipset = require('./Ipset.js');
Promise.promisifyAll(fs);


class Tag {
  constructor(o) {
    this.o = o;
    this._policy = {};
    const c = require('./MessageBus.js');
    this.subscriber = new c('info');
    if (f.isMain()) {
      if (o && o.uid) {
        this.subscriber.subscribeOnce("DiscoveryEvent", "TagPolicy:Changed", this.o.uid, (channel, type, id, obj) => {
          log.info(`Tag policy is changed on ${this.o.uid} ${this.o.name}`, obj);
          this.applyPolicy();
        });
      }
    }
    return this;
  }

  update(o) {
    this.o = o;
  }

  toJson() {
    const json = Object.assign({}, this.o, {policy: this._policy});
    return json;
  }

  setTagName(name) {
    this.o.name = name;
  }

  getTagName() {
    return this.o.name;
  }

  getTagUid() {
    return this.o.uid;
  }

  _getPolicyKey() {
    return `policy:tag:${this.o.uid}`;
  }

  async applyPolicy() {
    await this.loadPolicy();
    const policy = JSON.parse(JSON.stringify(this._policy));
    await pm.executeAsync(this, this.o.uid, policy);
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
      setTimeout(() => {
        this.subscriber.publish("DiscoveryEvent", "TagPolicy:Changed", this.o.uid, {name, data});
      }, 2000); // 2 seconds buffer for concurrent policy dta change to be persisted
    }
  }

  // this can be used to match everything on this tag, including device and network
  static getTagIpsetName(uid) {
    return `c_tag_${uid}_set`;
  }

  // this can be used to match device alone on this tag
  static getTagMacIpsetName(uid) {
    return `c_tag_${uid}_m_set`
  }

  // this can be used to match network alone on this tag
  static getTagNetIpsetName(uid) {
    return `c_tag_${uid}_n_set`;
  }

  // this can be used to match IP of device alone on this tag
  static getTagMacTrackingIpsetName(uid) {
    return `c_tag_${uid}_tracking_set`;
  }

  async createEnv() {
    // create related ipsets
    await exec(`sudo ipset create -! ${Tag.getTagIpsetName(this.o.uid)} list:set`).catch((err) => {
      log.error(`Failed to create tag ipset ${Tag.getTagIpsetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset create -! ${Tag.getTagMacIpsetName(this.o.uid)} hash:mac`).catch((err) => {
      log.error(`Failed to create tag mac ipset ${Tag.getTagMacIpsetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset add -! ${Tag.getTagIpsetName(this.o.uid)} ${Tag.getTagMacIpsetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to add ${Tag.getTagMacIpsetName(this.o.uid)} to ipset ${Tag.getTagIpsetName(this.o.uid)}`, err.message);
    });
    // you may think this tag net set is redundant? 
    // it is needed to apply fine-grained policy on tag level. e.g., customized wan, QoS
    await exec(`sudo ipset create -! ${Tag.getTagNetIpsetName(this.o.uid)} list:set`).catch((err) => {
      log.error(`Failed to create tag net ipset ${Tag.getTagNetIpsetName(this.o.uid)}`, err.message);
    });
    // it is needed to apply device tag level policy which needs destination IP
    await exec(`sudo ipset create -! ${Tag.getTagMacTrackingIpsetName(this.o.uid)} list:set`).catch((err) => {
      log.error(`Failed to create tag mac tracking ipset ${Tag.getTagMacTrackingIpsetName(this.o.uid)}`, err.message);
    });

    // tag dnsmasq entry can be referred by domain blocking rules
    const dnsmasqEntry = `group-tag=@${this.o.uid}$tag_${this.o.uid}`;
    await fs.writeFileAsync(`${f.getUserConfigFolder()}/dnsmasq/tag_${this.o.uid}_${this.o.uid}.conf`, dnsmasqEntry).catch((err) => {
      log.error(`Failed to create dnsmasq entry for tag ${this.o.uid}`, err.message);
    });
  }

  async destroyEnv() {
    const PM2 = require('../alarm/PolicyManager2.js');
    const pm2 = new PM2();
    await pm2.deleteTagRelatedPolicies(this.o.uid);
    const EM = require('../alarm/ExceptionManager.js');
    const em = new EM();
    await em.deleteTagRelatedExceptions(this.o.uid);

    const FlowAggrTool = require('../net2/FlowAggrTool');
    const flowAggrTool = new FlowAggrTool();
    const FlowManager = require('../net2/FlowManager.js');
    const flowManager = new FlowManager('info');

    await flowAggrTool.removeAggrFlowsAllTag(this.o.uid);
    await flowManager.removeFlowTag(this.o.uid);

    // flush related ipsets
    await exec(`sudo ipset flush -! ${Tag.getTagIpsetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to flush tag ipset ${Tag.getTagIpsetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset flush -! ${Tag.getTagMacIpsetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to flush tag mac ipset ${Tag.getTagMacIpsetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset flush -! ${Tag.getTagNetIpsetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to flush tag net ipset ${Tag.getTagNetIpsetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset flush -! ${Tag.getTagMacTrackingIpsetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to flush tag mac tracking ipset ${Tag.getTagMacTrackingIpsetName(this.o.uid)}`, err.message);
    });
    // delete related dnsmasq config files
    await exec(`sudo rm -f ${f.getUserConfigFolder()}/dnsmasq/tag_${this.o.uid}_*`).catch((err) => {}); // delete files in global effective directory
    await exec(`sudo rm -f ${f.getUserConfigFolder()}/dnsmasq/*/tag_${this.o.uid}_*`).catch((err) => {}); // delete files in network-wise effective directories
  }

  async spoof(state) {
    // do nothing for spoof on tag
  }

  async _dnsmasq(config) {
    // do nothing for dnsmasq on tag
  }

  async shield(policy) {
    let internetDevGroupRule = new Rule().chn("FW_F_DEV_G_SELECTOR")
      .mth(Tag.getTagMacTrackingIpsetName(this.o.uid), "dst", "set", true)
      .mth(ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src", "set", false)
      .pam("-m conntrack --ctstate NEW");
    let internetDevGroupRule6 = internetDevGroupRule.clone().fam(6);
    let intranetDevGroupRule = new Rule().chn("FW_F_DEV_G_SELECTOR")
      .mth(Tag.getTagMacTrackingIpsetName(this.o.uid), "dst", "set", true)
      .mth(ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src", "set", true)
      .mth(Tag.getTagIpsetName(this.o.uid), "src,src", "set", false)
      .pam("-m conntrack --ctstate NEW");
    let intranetDevGroupRule6 = intranetDevGroupRule.clone().fam(6);

    let internetNetGroupRule = new Rule().chn("FW_F_NET_G_SELECTOR")
      .mth(Tag.getTagNetIpsetName(this.o.uid), "dst,dst", "set", true)
      .mth(ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src", "set", false)
      .pam("-m conntrack --ctstate NEW");
    let internetNetGroupRule6 = internetNetGroupRule.clone().fam(6);
    let intranetNetGroupRule = new Rule().chn("FW_F_NET_G_SELECTOR")
      .mth(Tag.getTagNetIpsetName(this.o.uid), "dst,dst", "set", true)
      .mth(ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src", "set", true)
      .mth(Tag.getTagIpsetName(this.o.uid), "src,src", "set", false)
      .pam("-m conntrack --ctstate NEW");
    let intranetNetGroupRule6 = intranetNetGroupRule.clone().fam(6);
    // remove all possible previous rules
    await exec(internetDevGroupRule.clone().jmp("FW_INBOUND_FIREWALL").toCmd("-D")).catch((err) => {});
    await exec(internetDevGroupRule.clone().jmp("RETURN").toCmd("-D")).catch((err) => {});
    await exec(internetDevGroupRule6.clone().jmp("FW_INBOUND_FIREWALL").toCmd("-D")).catch((err) => {});
    await exec(internetDevGroupRule6.clone().jmp("RETURN").toCmd("-D")).catch((err) => {});
    await exec(internetNetGroupRule.clone().jmp("FW_INBOUND_FIREWALL").toCmd("-D")).catch((err) => {});
    await exec(internetNetGroupRule.clone().jmp("RETURN").toCmd("-D")).catch((err) => {});
    await exec(internetNetGroupRule6.clone().jmp("FW_INBOUND_FIREWALL").toCmd("-D")).catch((err) => {});
    await exec(internetNetGroupRule6.clone().jmp("RETURN").toCmd("-D")).catch((err) => {});
    await exec(intranetDevGroupRule.clone().jmp("FW_INBOUND_FIREWALL").toCmd("-D")).catch((err) => {});
    await exec(intranetDevGroupRule.clone().jmp("RETURN").toCmd("-D")).catch((err) => {});
    await exec(intranetDevGroupRule6.clone().jmp("FW_INBOUND_FIREWALL").toCmd("-D")).catch((err) => {});
    await exec(intranetDevGroupRule6.clone().jmp("RETURN").toCmd("-D")).catch((err) => {});
    await exec(intranetNetGroupRule.clone().jmp("FW_INBOUND_FIREWALL").toCmd("-D")).catch((err) => {});
    await exec(intranetNetGroupRule.clone().jmp("RETURN").toCmd("-D")).catch((err) => {});
    await exec(intranetNetGroupRule6.clone().jmp("FW_INBOUND_FIREWALL").toCmd("-D")).catch((err) => {});
    await exec(intranetNetGroupRule6.clone().jmp("RETURN").toCmd("-D")).catch((err) => {});

    let cmd = "-I";
    if (policy.internet !== true && policy.internet !== false)
      policy.internet = null;
    if (policy.internet === true) {
      internetDevGroupRule.jmp("FW_INBOUND_FIREWALL");
      internetDevGroupRule6.jmp("FW_INBOUND_FIREWALL");
      internetNetGroupRule.jmp("FW_INBOUND_FIREWALL");
      internetNetGroupRule6.jmp("FW_INBOUND_FIREWALL");
    }
    if (policy.internet === false) {
      internetDevGroupRule.jmp("RETURN");
      internetDevGroupRule6.jmp("RETURN");
      internetNetGroupRule.jmp("RETURN");
      internetNetGroupRule6.jmp("RETURN");
    }
    if (policy.internet === null) {
      cmd = "-D";
    }
    await exec(internetDevGroupRule.toCmd(cmd)).catch((err) => {
      log.error(`Failed to apply IPv4 internet inbound firewall for ${this.o.uid}`, internetDevGroupRule.toCmd(cmd), err.message);
    });
    await exec(internetDevGroupRule6.toCmd(cmd)).catch((err) => {
      log.error(`Failed to apply IPv6 internet inbound firewall for ${this.o.uid}`, internetDevGroupRule6.toCmd(cmd), err.message);
    });
    await exec(internetNetGroupRule.toCmd(cmd)).catch((err) => {
      log.error(`Failed to apply IPv4 internet inbound firewall for ${this.o.uid}`, internetNetGroupRule.toCmd(cmd), err.message);
    });
    await exec(internetNetGroupRule6.toCmd(cmd)).catch((err) => {
      log.error(`Failed to apply IPv6 internet inbound firewall for ${this.o.uid}`, internetNetGroupRule6.toCmd(cmd), err.message);
    });

    cmd = "-I";
    if (policy.intranet !== true && policy.intranet !== false)
      policy.intranet = null;
    if (policy.intranet === true) {
      intranetDevGroupRule.jmp("FW_INBOUND_FIREWALL");
      intranetDevGroupRule6.jmp("FW_INBOUND_FIREWALL");
      intranetNetGroupRule.jmp("FW_INBOUND_FIREWALL");
      intranetNetGroupRule6.jmp("FW_INBOUND_FIREWALL");
    }
    if (policy.intranet === false) {
      intranetDevGroupRule.jmp("RETURN");
      intranetDevGroupRule6.jmp("RETURN");
      intranetNetGroupRule.jmp("RETURN");
      intranetNetGroupRule6.jmp("RETURN");
    }
    if (policy.intranet === null) {
      cmd = "-D";
    }
    await exec(intranetDevGroupRule.toCmd(cmd)).catch((err) => {
      log.error(`Failed to apply IPv4 intranet inbound firewall for ${this.o.uid}`, intranetDevGroupRule.toCmd(cmd), err.message);
    });
    await exec(intranetDevGroupRule6.toCmd(cmd)).catch((err) => {
      log.error(`Failed to apply IPv6 intranet inbound firewall for ${this.o.uid}`, intranetDevGroupRule6.toCmd(cmd), err.message);
    });
    await exec(intranetNetGroupRule.toCmd(cmd)).catch ((err) => {
      log.error(`Failed to apply IPv4 intranet inbound firewall for ${this.o.uid}`, intranetNetGroupRule.toCmd(cmd), err.message);
    });
    await exec(intranetNetGroupRule6.toCmd(cmd)).catch ((err) => {
      log.error(`Failed to apply IPv6 intranet inbound firewall for ${this.o.uid}`, intranetNetGroupRule6.toCmd(cmd), err.message);
    });
  }

  async vpnClient(policy) {
    try {
      const state = policy.state;
      const profileId = policy.profileId;
      if (!profileId) {
        log.warn(`VPN client profileId is not specified for ${this.o.uid} ${this.o.name}`);
        return false;
      }
      const ovpnClient = new OpenVPNClient({profileId: profileId});
      const intf = ovpnClient.getInterfaceName();
      const rtId = await vpnClientEnforcer.getRtId(intf);
      if (!rtId)
        return false;
      const rtIdHex = Number(rtId).toString(16);
      // remove old mark first
      await exec(`sudo ipset -! del c_vpn_client_tag_m_set ${Tag.getTagMacIpsetName(this.o.uid)}`);
      if (this._netFwMark) {
        let cmd = wrapIptables(`sudo iptables -w -t mangle -D FW_RT_VC_TAG_NETWORK -m set --match-set ${Tag.getTagNetIpsetName(this.o.uid)} src,src -j MARK --set-mark 0x${this._netFwMark}/0xffff`);
        await exec(cmd).catch((err) => {});
        cmd = wrapIptables(`sudo ip6tables -w -t mangle -D FW_RT_VC_TAG_NETWORK -m set --match-set ${Tag.getTagNetIpsetName(this.o.uid)} src,src -j MARK --set-mark 0x${this._netFwMark}/0xffff`);
        await exec(cmd).catch((err) => {});
      }
      this._netFwMark = null;
      if (state === true) {
        // set skbmark
        this._netFwMark = rtIdHex;
      }
      if (state === false) {
        // reset skbmark
        this._netFwMark = "0000";
      }
      if (state === null) {
        // do not change skbmark
      }
      if (this._netFwMark) {
        await exec(`sudo ipset -! add c_vpn_client_tag_m_set ${Tag.getTagMacIpsetName(this.o.uid)} skbmark 0x${this._netFwMark}/0xffff`);
        // add to the beginning of the chain so that it has the lowest priority and can be overriden by the subsequent rules 
        let cmd = wrapIptables(`sudo iptables -w -t mangle -I FW_RT_VC_TAG_NETWORK -m set --match-set ${Tag.getTagNetIpsetName(this.o.uid)} src,src -j MARK --set-mark 0x${this._netFwMark}/0xffff`);
        await exec(cmd).catch((err) => {});
        cmd = wrapIptables(`sudo ip6tables -w -t mangle -I FW_RT_VC_TAG_NETWORK -m set --match-set ${Tag.getTagNetIpsetName(this.o.uid)} src,src -j MARK --set-mark 0x${this._netFwMark}/0xffff`);
        await exec(cmd).catch((err) => {});
      }
      return true;
    } catch (err) {
      log.error(`Failed to set VPN client access on tag ${this.o.uid} ${this.o.name}`, err.message);
      return false;
    }
  }

  async tags(tags) {
    // do not support embedded tags
  }
}

module.exports = Tag;