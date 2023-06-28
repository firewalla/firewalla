/*    Copyright 2016-2021 Firewalla Inc.
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

const _ = require('lodash');
const exec = require('child-process-promise').exec;
const log = require('../net2/logger.js')(__filename);
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Sensor = require('./Sensor.js').Sensor;
const Message = require('../net2/Message.js');

const Constants = require('../net2/Constants.js');
const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();

const tagManager = require('../net2/TagManager');
const networkProfileManager = require('../net2/NetworkProfileManager.js');
const identityManager = require('../net2/IdentityManager.js');
const virtWanGroupManager = require('../net2/VirtWanGroupManager.js');

const rclient = require('../util/redis_manager.js').getRedisClient();

const OSI_KEY = "osi:active";
const OSI_PBR_KEY = "osi:pbr:active";
const OSI_ADMIN_STOP_KEY = "osi:admin:stop";

const platform = require('../platform/PlatformLoader.js').getPlatform();

const PolicyManager2 = require('../alarm/PolicyManager2.js')
const pm2 = new PolicyManager2()

class OSIPlugin extends Sensor {
  run() {
    if (! platform.supportOSI()) {
      return;
    }

    log.info("Setting up OSI ...");

    const autoStopTime = this.config.autoStop || 30 * 60 * 1000;
    const updateInterval = this.config.updateInterval || 5 * 60 * 1000;

    setTimeout(() => {
      this.stop().catch((err) => {});
    }, autoStopTime);

    this.vpnClientDone = false;
    this.pbrDone = false;

    sem.on(Message.MSG_OSI_GLOBAL_VPN_CLIENT_POLICY_DONE, async () => {
      log.info("Flushing osi_match_all_knob");
      await exec("sudo ipset flush -! osi_match_all_knob").catch((err) => { });

      this.vpnClientDone = true;
      if (this.pbrDone) {
        this.releaseBrake().catch((err) => {});
      }
    });

    sem.on(Message.MSG_OSI_PBR_RULES_DONE, async () => {
      log.info("Flushing osi_pbr_match_all_knob");
      await exec("sudo ipset flush -! osi_pbr_match_all_knob").catch((err) => { });

      this.pbrDone = true;
      if (this.vpnClientDone) {
        this.releaseBrake().catch((err) => {});
      }
    });

    sem.on(Message.MSG_OSI_VERIFIED, async (event) => {
      switch(event.targetType) {
        case "Host": {
          log.info(`Marked mac ${event.uid} as verified`);
          exec(`sudo ipset add -! osi_verified_mac_set ${event.uid}`).catch((err) => { });
          break;
        }
        case "Tag": {
          const activeItems = await rclient.smembersAsync(OSI_KEY);
          for (const item of activeItems) {
            if (item.startsWith(`tag,${event.uid},`)) {
              const mac = item.replace(`tag,${event.uid},`, "");
              log.info(`Marked tag ${event.uid} mac ${mac} as verified`);
              exec(`sudo ipset add -! osi_verified_mac_set ${mac}`).catch((err) => { });
            }
          }
          break;
        }
        case "NetworkProfile": {
          const activeItems = await rclient.smembersAsync(OSI_KEY);
          for (const item of activeItems) {
            if (item.startsWith(`network,${event.uid},`)) {
              const subnet = item.replace(`network,${event.uid},`, "");
              log.info(`Marked network ${event.uid} subnet ${subnet} as verified`);
              exec(`sudo ipset add -! osi_verified_subnet_set ${subnet}`).catch((err) => { });
            }
          }
          break;
        }
        case "WGPeer": {
          const activeItems = await rclient.smembersAsync(OSI_KEY);
          for (const item of activeItems) {
            if (item.startsWith(`identity,${event.uid},`)) {
              const ip = item.replace(`identity,${event.uid},`, "");
              log.info(`Marked WireGuard ${event.uid} ip ${ip} as verified`);
              exec(`sudo ipset add -! osi_verified_subnet_set ${ip}`).catch((err) => { });
            }
          }
          break;
        }
        default: {
          log.error("Unknown target type in MSG_OSI_VERIFIED event", event);
        }
      }
    });
  }

  // release brake when PBR rules and VPN client policies are applied
  async releaseBrake() {

    sem.on(Message.MSG_OSI_UPDATE_NOW, (event) => {
      this.updateOSIPool();
    });

    // DO NOT UPDATE OSI Pool too soon, only after knob off is triggered
    this.updateOSIPool();

    setInterval(() => {
      this.updateOSIPool();
    }, updateInterval);
  }

  // disable this feature at all, no more osi
  async cleanup() {
      await rclient.delAsync(OSI_KEY);
      await rclient.delAsync(OSI_PBR_KEY);
      await exec("sudo ipset flush -! osi_mac_set").catch((err) => {});
      await exec("sudo ipset flush -! osi_subnet_set").catch((err) => {});
      await exec("sudo ipset flush -! osi_pbr_mac_set").catch((err) => {});
      await exec("sudo ipset flush -! osi_pbr_subnet_set").catch((err) => {});
  }

  hasValidProfileId(x) {
    return x.policy && 
    x.policy.vpnClient && 
    x.policy.vpnClient.state && 
    x.policy.vpnClient.profileId;
  }

  async stop() {
    log.info("Stopping OSI...");
    this._stop = true;
    await this.cleanup();
    log.info("Stopped OSI");
  }

  async adminStop() {
    await rclient.setAsync(OSI_ADMIN_STOP_KEY, "1");
  }

  async shouldStop() {
    if (this._stop) {
      return true;
    }

    // do not use feature knob to reduce dependancies
    const stopSign = await rclient.typeAsync(OSI_ADMIN_STOP_KEY);
    if (stopSign !== "none") {
      return true;
    }

    return false;
  }

  async updateOSIPool() {

    if (await this.shouldStop()) {
      log.info("OSI update is stopped");
      await this.cleanup();
      return;
    }

    const macs = [];
    const taggedMacs = [];
    const networks = [];
    const matchedIdentities = [];
    const matchedPolicies = [];

    const begin = Date.now() / 1;

    try {
      const policy = hostManager.getPolicyFast();
      if (policy.vpnClient) {
        const profileIds = await hostManager.getAllActiveStrictVPNClients(policy.vpnClient);

        const tagsWithVPN = [];
        const pbrTagsWithVPN = [];


        const policies = await pm2.loadActivePoliciesAsync();
        // route policies are much smaller, maybe we should cache them
        // not sure how expensive to load active policies every x minutes
        const validRoutePolicies = policies.filter((x) =>
          x.type === "route" &&
          x.routeType === "hard" &&
          x.wanUUID &&
          profileIds.includes(x.wanUUID.replace(Constants.ACL_VPN_CLIENT_WAN_PREFIX, "")));

        await rclient.delAsync(OSI_PBR_KEY);

        for (const policy of validRoutePolicies) {
          // all devices
          if (policy.type === "mac" && policy.scope === "") {
            await rclient.saddAsync(OSI_PBR_KEY, "all,0.0.0.0/1", "all,128.0.0.0/1");
          // mac
          } else if (policy.type === "mac" && !_.isEmpty(policy.scope)) {
            await rclient.saddAsync(OSI_PBR_KEY, policy.scope.map((x) => `mac,${x}`));
          // tag
          }
        }






        // GROUP
        const tagJson = await tagManager.toJson();
        for (const tag of Object.values(tagJson)) {
          if (this.hasValidProfileId(tag)) {
            const hostProfileId = tag.policy.vpnClient.profileId;
            if (profileIds.includes(hostProfileId)) {
              tagsWithVPN.push(tag.uid);
            }
          }
        }

        // HOST
        for (const host of hostManager.getHostsFast()) {
          if (this.hasValidProfileId(host)) {
            const hostProfileId = host.policy.vpnClient.profileId;
            if (profileIds.includes(hostProfileId)) {
              macs.push(host.o.mac);
            }
          }

          // TAGGED HOST
          const tags = await host.getTags();
          const intersection = _.intersection(tags, tagsWithVPN);
          if (!_.isEmpty(intersection)) {
            taggedMacs.push({
              tag: intersection[0],
              mac: host.o.mac
            });
          }
        }

        // NETWORK
        for (const network of Object.values(networkProfileManager.networkProfiles)) {
          if (this.hasValidProfileId(network)) {
            const networkVPNProfileId = network.policy.vpnClient.profileId;
            if (profileIds.includes(networkVPNProfileId)) {
              networks.push({
                uid: network.getUniqueId(),
                ipv4Subnets: network.o.ipv4Subnets,
                ipv6Subnets: network.o.ipv6Subnets
              });
            }
          }
        }

        // Identity: WireGuard, VPN
        for (const identities of Object.values(identityManager.getAllIdentities())) {
          for(const identity of Object.values(identities)) {
            if (this.hasValidProfileId(identity)) {
              const profileId = identity.policy.vpnClient.profileId;
              if (profileIds.includes(profileId)) {
                matchedIdentities.push({
                  uid: identity.getUniqueId(),
                  ips: identity.getIPs()
                });
              }
            }
          }
        }

      }


      await rclient.delAsync(OSI_KEY);

      if (!_.isEmpty(macs)) {
        // mac,20:6D:31:00:00:01
        await rclient.saddAsync(OSI_KEY, macs.map((mac) => `mac,${mac}`));
      }

      if (!_.isEmpty(taggedMacs)) {
        // tag,1,20:6D:31:00:00:01
        await rclient.saddAsync(OSI_KEY, taggedMacs.map((info) => `tag,${info.tag},${info.mac}`));
      }

      if (!_.isEmpty(networks)) {
        // network,4556474a-e7be-43af-bcf1-c61fe9731a47,192.168.20.0/24
        for(const network of networks) {
          for(const v4 of network.ipv4Subnets) {
            await rclient.saddAsync(OSI_KEY, `network,${network.uid},${v4}`);
          }
          for(const v6 of network.ipv6Subnets) {
            await rclient.saddAsync(OSI_KEY, `network,${network.uid},${v6}`);
          }
        }
      }

      if (!_.isEmpty(matchedIdentities)) {
        // identity,I1kq9nSVIMnIwZmtNV17TQshU5+O4JkrrKKy/fl9I00=,10.11.12.13/32
        for(const identity of matchedIdentities) {
          for(const ip of identity.ips) {
            await rclient.saddAsync(OSI_KEY, `identity,${identity.uid},${ip}`);
          }
        }
      }

    } catch (err) {
      log.error("Got error when updating OSI pool", err);
    }

    const end = Date.now() / 1;
    log.info(`OSI pool updated in ${end - begin} ms`);
  }
}

module.exports = OSIPlugin;
