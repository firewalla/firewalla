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

class OSIPlugin extends Sensor {
  run() {
    sem.on(Message.MSG_OSI_MATCH_ALL_KNOB_OFF, async () => {
        log.info("Flushing osi_match_all_knob");
        // await delay(15 * 1000); // waiting for 15 seconds just to be safe
        await exec("sudo ipset flush -! osi_match_all_knob").catch((err) => {});
    });

    sem.on(Message.MSG_OSI_MAC_VERIFIED, (event) => {
        if (event.mac) {
            log.info(`Marked mac ${event.mac} as verified`);
            exec(`sudo ipset add -! osi_verified_mac_set ${event.mac}`).catch((err) => { });
        } else {
            log.error("No mac found in MSG_OSI_MAC_VERIFIED event");
        }
    });

    sem.on(Message.MSG_OSI_SUBNET_VERIFIED, (event) => {
        if (event.subnet) {
            log.info(`Marked subnet ${event.subnet} as verified`);
            exec(`sudo ipset add -! osi_verified_subnet_set ${event.subnet}`).catch((err) => { });
        } else {
            log.error("No subnet found in MSG_OSI_SUBNET_VERIFIED event");
        }
    });

    sem.on(Message.MSG_OSI_UPDATE_NOW, (event) => {
      this.updateOSIPool();
    });

    // no longer require this, as timeout is controlled by ipset
    // // force disable OSI after 30 mins, as a protection
    // setTimeout(() => {
    //     exec("sudo ipset flush -! osi_mac_set").catch((err) => {});
    //     exec("sudo ipset flush -! osi_subnet_set").catch((err) => {});
    // }, 30 * 60 * 1000)

    setInterval(() => {
        this.updateOSIPool();
    }, 30 * 1000);
    //}, 15 * 60 * 1000)
  }

  async updateOSIPool() {
    const macs = [];
    const taggedMacs = [];
    const subnets = [];

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
            taggedMacs.push(`${intersection[0]},${host.o.mac}`);
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
              subnets.push.apply(subnets, network.o.ipv4Subnets);
              subnets.push.apply(subnets, network.o.ipv6Subnets);
            }
          }
        }
      }

      await rclient.delAsync("osi:active");

      if (!_.isEmpty(macs)) {
        // mac,20:6D:31:00:00:01
        await rclient.saddAsync("osi:active", macs.map((mac) => `mac,${mac}`));
      }

      if (!_.isEmpty(taggedMacs)) {
        // tag,1,20:6D:31:00:00:01
        await rclient.saddAsync("osi:active", taggedMacs.map((mac) => `tag,${mac}`));
      }

      if (!_.isEmpty(subnets)) {
        // network,192.168.20.0/24
        await rclient.saddAsync("osi:active", subnets.map((subnet) => `network:${subnet}`));
      }

    } catch (err) {
      log.error("Got error when updating OSI pool", err);
    }

    const end = Date.now() / 1;
    log.info(`OSI pool updated in ${end - begin} ms`);
  }
}

module.exports = OSIPlugin;
