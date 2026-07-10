/*    Copyright 2025 Firewalla Inc.
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
const net = require('net');

const extensionManager = require('./ExtensionManager.js');
const Sensor = require('./Sensor.js').Sensor;

const netconsole = require("../extension/netconsole/netconsole.js");
const fc = require('../net2/config.js')
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();
const log = require('../net2/logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient();
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();

const featureName = "netconsole";
const policyKeyName = "netconsole";
const LOCK_APPLY_NETCONSOLE_POLICY = "LOCK_APPLY_NETCONSOLE_POLICY";

class NetconsolePlugin extends Sensor {
    constructor(config) {
        super(config);
        this.featureOn = false;
    }

    async globalOff() {
        this.featureOn = false;
        await this.applyPolicy({}, "0.0.0.0", {}); // uninstall if installed
    }

    async globalOn() {
        this.featureOn = true;
        // get policy
        const policy = await this._getHostPolicy();
        await this.applyPolicy({}, "0.0.0.0", policy);
    }

    async run() {
        this.featureOn = fc.isFeatureOn(featureName);
        extensionManager.registerExtension(featureName, this, {
            applyPolicy: this.applyPolicy
        })
        this.hookFeature(featureName);

    }
    // policy: netconsole
    async _getHostPolicy() {
        const data = await rclient.hgetAsync(hostManager._getPolicyKey(), policyKeyName);
        if (data) {
            try {
                return JSON.parse(data);
            } catch (err) {
                log.warn(`fail to load netconsole policy`);
                return {};
            };
        }
    }
    // policy: {src_intf: "eth0", dst_port: 8866, dst_ip: "192.168.62.1", dst_mac: "20:6d:31:df:18:ed"}
    async applyPolicy(host, ip, policy) {
        if (!this.featureOn) {
            // if policy is not empty, skip to apply
            if (!this.isEmptyPolicy(policy)) {
                log.info("skip to apply policy netconsole, feature netconsole is disabled");
                return;
            }
        }
        if (ip !== "0.0.0.0") {
            log.warn("skip to apply policy netconsole, target is not supported for netconsole policy", ip);
            return;
        }
        if (!policy) {
            log.info("skip to apply empty policy netconsole", ip);
            return;
        }
        log.info("start to apply policy netconsole", ip, policy);
        await lock.acquire(LOCK_APPLY_NETCONSOLE_POLICY, async () => {
            await this._applyPolicy(policy);
        }).catch((err) => {
            log.error(`failed to get lock to apply ${featureName} policy`, err.message);
        });
    }

    isValidPolicy(policy) {
        if (!policy) {
            return false;
        }
        if (!policy.src_intf || !policy.dst_port || !policy.dst_ip || !policy.dst_mac) {
            log.warn("netconsole policy is invalid, missing required fields, policy: ", policy);
            return false;
        }

        if (typeof policy.src_intf !== 'string' || policy.src_intf.length === 0) {
            log.warn("netconsole policy is invalid, src_intf is not a valid string", policy);
            return false;
        }

        // check if dst_port is a valid port number
        if (!Number.isInteger(policy.dst_port) || policy.dst_port < 1 || policy.dst_port > 65535) {
            log.warn("netconsole policy is invalid, dst_port is not a valid port number", policy);
            return false;
        }

        // Check if dst_ip is a valid IPv4 or IPv6 address
        if (!net.isIPv4(policy.dst_ip) && !net.isIPv6(policy.dst_ip)) {
            log.warn("netconsole policy is invalid, dst_ip is not a valid ip address", policy);
            return false;
        }

        // Check if dst_mac is a valid MAC address format
        if (!hostTool.isMacAddress(policy.dst_mac)) {
            log.warn("netconsole policy is invalid, dst_mac is not a valid mac address", policy);
            return false;
        }


        return true;
    }

    isEmptyPolicy(policy) {
        if (!policy) {
            return true;
        }
        if (!policy.src_intf && !policy.dst_port && !policy.dst_ip && !policy.dst_mac) {
            return true;
        }
        return false;
    }

    async _applyPolicy(policy) {
        if (this.isEmptyPolicy(policy)) {
            await netconsole.uninstallNetconsole();
            return;
        }
        if (!this.isValidPolicy(policy)) {
            log.warn("netconsole policy is invalid, skip to apply", policy);
            return;
        }
        await netconsole.installNetconsole(policy);
    }
}

module.exports = NetconsolePlugin;