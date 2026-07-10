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

const exec = require('child-process-promise').exec;
const _ = require('lodash');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const log = require('../../net2/logger.js')(__filename);

class Netconsole {
    constructor(config) {
        this.config = config;
    }

    async isAvailable() {
        // /lib/modules/5.15.78/kernel/drivers/net/netconsole.ko
        const kernelVersion = await exec("uname -r").then((r) => r.stdout.trim()).catch((e) => "");
        if (!kernelVersion) {
            return false;
        }
        const kmpath = `/lib/modules/${kernelVersion}/kernel/drivers/net/netconsole.ko`;
        return await fs.accessAsync(kmpath).then(() => true).catch(() => false)
    }

    async isInstalled() {
        const cmd = "lsmod | grep -q netconsole";
        return await exec(cmd).then((r) => true).catch(() => false);
    }

    async installNetconsole(config = {}) {
        try {
            if (!await this.isAvailable()) {
                log.error("netconsole module not available");
                return;
            }
            if (!config && Object.keys(config).length === 0) {
                log.error("netconsole config is required");
                return;
            }
            // if installed, uninstall first
            if (await this.isInstalled()) {
                await this.uninstall();
            }
            const { src_intf, dst_port, dst_ip, dst_mac } = config;
            if (!src_intf || !dst_port || !dst_ip || !dst_mac) {
                log.error("netconsole config is invalid");
                return;
            }
            await this.install(src_intf, dst_port, dst_ip, dst_mac);

        } catch (e) {
            log.error(`failed to install netconsole, ${e.message}`);
            return;
        }
    }

    async uninstallNetconsole() {
        try {
            if (!await this.isInstalled()) {
                log.warn("netconsole is not installed");
                return;
            }
            await this.uninstall();
        } catch (e) {
            log.error(`failed to uninstall netconsole, ${e.message}`);
            return;
        }
    }

    // sudo modprobe netconsole netconsole=@/eth0,8866@192.168.62.1/20:6d:31:df:18:ed
    async install(src_intf, dst_port, dst_ip, dst_mac) {
        if (!src_intf || !dst_port || !dst_ip || !dst_mac) {
            log.error("netconsole config is invalid");
            return;
        }

        const cmd = `sudo modprobe netconsole netconsole=@/${src_intf},${dst_port}@${dst_ip}/${dst_mac}`;
        await exec(cmd).then((r) => {
            log.info(`netconsole installed: ${cmd}`);
        }).catch((e) => {
            log.error(`failed to install netconsole, ${cmd}, error: ${e.message}`);
        });
    }

    async uninstall() {
        const cmd = "sudo modprobe -r netconsole";
        await exec(cmd).then((r) => {
            log.info(`netconsole uninstalled: ${cmd}`);
        }).catch((e) => {
            log.error(`failed to uninstall netconsole, ${cmd}, error: ${e.message}`);
        });
    }
}

module.exports = new Netconsole();
