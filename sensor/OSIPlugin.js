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

const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();

const tagManager = require('../net2/TagManager');
const networkProfileManager = require('../net2/NetworkProfileManager.js');
const identityManager = require('../net2/IdentityManager.js');
const virtWanGroupManager = require('../net2/VirtWanGroupManager.js');

const delay = require('../util/util.js').delay;
const rclient = require('../util/redis_manager.js').getRedisClient();

const OSI_KEY = "osi:active";

class OSIPlugin extends Sensor {
  run() {
    sem.on(Message.MSG_OSI_MATCH_ALL_KNOB_OFF, async () => {
        log.info("Flushing osi_match_all_knob");
        // await delay(15 * 1000); // waiting for 15 seconds just to be safe
        await exec("sudo ipset flush -! osi_match_all_knob").catch((err) => {});

        sem.on(Message.MSG_OSI_UPDATE_NOW, (event) => {
          this.updateOSIPool();
        });
    
        // DO NOT UPDATE OSI Pool too soon
        setInterval(() => {
            this.updateOSIPool();
        }, 30 * 1000);
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
            if (item.startWith(`tag,${event.uid},`)) {
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
        default: {
          log.error("Unknown target type in MSG_OSI_VERIFIED event", event);
        }
      }
    });
  }

  async updateOSIPool() {
    const macs = [];
    const taggedMacs = [];
    const networks = [];

    const begin = Date.now() / 1;

    try {
      const policy = hostManager.getPolicyFast();
      if (policy.vpnClient) {
        const profileIds = await hostManager.getAllActiveStrictVPNClients(policy.vpnClient);

        const tagsWithVPN = [];

        // GROUP
        const tagJson = await tagManager.toJson();
        for (const tag of Object.values(tagJson)) {
          if (tag.policy && 
            tag.policy.vpnClient && 
            tag.policy.vpnClient.state && 
            tag.policy.vpnClient.profileId) {
            const hostProfileId = tag.policy.vpnClient.profileId;
            if (profileIds.includes(hostProfileId)) {
              tagsWithVPN.push(tag.uid);
            }
          }
        }

        // HOST
        for (const host of hostManager.getHostsFast()) {
          if (host.policy && 
            host.policy.vpnClient && 
            host.policy.vpnClient.state && 
            host.policy.vpnClient.profileId) {
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
          if (network.policy && 
            network.policy.vpnClient && 
            network.policy.vpnClient.state && 
            network.policy.vpnClient.profileId) {
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

    } catch (err) {
      log.error("Got error when updating OSI pool", err);
    }

    const end = Date.now() / 1;
    log.info(`OSI pool updated in ${end - begin} ms`);
  }
}

module.exports = OSIPlugin;
