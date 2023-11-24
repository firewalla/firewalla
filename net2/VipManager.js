/*    Copyright 2021-2023 Firewalla Inc.
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
const _ = require('lodash');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Message = require('./Message.js');

const ipTool = require('ip');
const rclient = require('../util/redis_manager').getRedisClient();

const CONFIG_KEY = "vip_profile.config";

function randomString(len) {
    const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    return _.times(len, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

class VipManager {
    constructor() {
      this.configMap = new Map();
      sem.on(Message.MSG_VIP_PROFILES_UPDATED, async () => {
        this.configMap = await this.load();
      });
    }

    async load() {
        const data = await rclient.hgetallAsync(CONFIG_KEY);
        const result = new Map();
        for (const uid in data) {
            result.set(uid, JSON.parse(data[uid]));
        }
        return result;
    }

    async create(profile) {
        const ip = profile.ip;
        const name = profile.name;
        const uid = randomString(16);
        profile.uid = uid;
        if (!ip || !name) {
            throw Error("Ip or name not given");
        }
        if (!ipTool.isV4Format(ip)) {
            throw Error("Invalid IPv4 address");
        }
        const configs = await this.load();
        for (const [key, config] of configs) {
            if (key === uid || config.ip === ip) {
                throw Error("VIP profile already exists");
            }
        }

        await rclient.hsetAsync(CONFIG_KEY, uid, JSON.stringify(profile));
        this.sendUpdateEvent();
        return uid;
    }

    async delete(uid) {
        if (!uid) {
            throw Error("Vip profile uid not given");
        }
        const configs = await this.load();
        let existed = configs.has(uid);
        await rclient.hdelAsync(CONFIG_KEY, uid);
        this.sendUpdateEvent();
        return existed;
    }

    sendUpdateEvent() {
        const event = {
            type: Message.MSG_VIP_PROFILES_UPDATED,
            cn: ""
        };
        sem.sendEventToAll(event);
    }

    async isVip(ipv4Addr) {
        const profiles = this.configMap;
        for (const [k, profile] of profiles) {
            if (profile.ip === ipv4Addr) {
                return true;
            }
        }
        return false;
    }
}

module.exports = new VipManager();
