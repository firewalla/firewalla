/*    Copyright 2021 Firewalla Inc
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

const log = require('../logger.js')(__filename);

const sysManager = require('../SysManager.js');

const Promise = require('bluebird');
const fs = require('fs');
Promise.promisifyAll(fs);
const Constants = require('../Constants.js');
const Message = require('../Message.js');

const Identity = require('../Identity.js');

const vipProfiles = {};

const vipManager = require('../VipManager.js');


class VIPProfile extends Identity {
    getUniqueId() {
        return this.o.uid;
    }

    static getNamespace() {
        return Constants.NS_VIP_PROFILE;
    }

    static getKeyOfUIDInAlarm() {
        return "p.device.vipProfile";
    }

    static getKeyOfInitData() {
        return "vipProfiles";
    }

    static async getInitData() {
        const result = [];
        for (const key of Object.keys(vipProfiles)) {
            const profile = vipProfiles[key];
            result.push(
                {
                    uid: key,
                    name: profile.o.name,
                    ip: profile.o.ip,
                    lastActiveTimestamp: null,
                    timestamp: null
                }
            );
        }
        return result;
    }

    static async getIdentities() {
        const vipConfigs = await vipManager.load();
        for (const [key, config] of vipConfigs) {
            if (vipProfiles[key]) {
                vipProfiles[key].update(config);
            } else {
                vipProfiles[key] = new VIPProfile(config);
            }
        }
        const removedProfileKeys = Object.keys(vipProfiles).filter((key) => !vipConfigs.has(key));

        for (const removedKey of removedProfileKeys) {
            delete vipProfiles[removedKey];
        }
        return vipProfiles;
    }

    static async getIPUniqueIdMappings() {
        const ipUidMap = {};
        for (const key of Object.keys(vipProfiles)) {
            ipUidMap[vipProfiles[key].o.ip] = key;
        }
        return ipUidMap;
    }

    static async getIPEndpointMappings() {
        const ipEndpointMap = {};
        for (const key of Object.keys(vipProfiles)) {
            const ip = vipProfiles[key].o.ip;
            ipEndpointMap[ip] = ip;
        }
        return ipEndpointMap;
    }

    static getRefreshIdentitiesHookEvents() {
        return [Message.MSG_SYS_NETWORK_INFO_RELOADED, Message.MSG_VIP_PROFILES_UPDATED];
    }

    static getRefreshIPMappingsHookEvents() {
        return [Message.MSG_VIP_PROFILES_UPDATED];
    }

    getLocalizedNotificationKeySuffix() {
        return ".vip";
    }

    getDeviceNameInNotificationContent(alarm) {
        return alarm["p.device.real.ip"];
    }

    getReadableName() {
        return this.o.name;
    }

    getNicName() {
        return sysManager.getInterfaceViaIP(this.o.ip, true);
    }
}

module.exports = VIPProfile;