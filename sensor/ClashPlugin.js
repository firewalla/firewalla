/*    Copyright 2021 Firewalla LLC
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

const f = require('../net2/Firewalla.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dnsmasq`;
const systemConfigFile = `${dnsmasqConfigFolder}/clash_system.conf`;

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec;

const sysManager = require('../net2/SysManager.js');

const extensionManager = require('./ExtensionManager.js');

const featureName = "clash";
const policyKeyName = "clash";

const clash = require('../extension/clash_tun/clash_tun.js');

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

class ClashPlugin extends Sensor {
  async run() {
    if(!platform.isFireRouterManaged()) {
      return;
    }
    
    this.adminSystemSwitch = false;
    await exec(`mkdir -p ${dnsmasqConfigFolder}`);
    extensionManager.registerExtension(policyKeyName, this, {
      applyPolicy: this.applyPolicy
    });

    this.hookFeature(featureName);
    
  }

  async applyAll(options = {}) {
    log.info("Applying...");
    const config = await this.getFeatureConfig();
    clash.config = Object.assign({}, config,  {dns: sysManager.myDefaultDns()});
    await clash.start();
    this.ready = true;

    await this.applyClash();
  }

  async applyPolicy(host, ip, policy) {
    log.info("Applying clash policy:", ip, policy);
    if (ip === '0.0.0.0') {
      // not supported
      return;
    }

    if (!host)
      return;

    // only support Host
    if (host.constructor.name !== "Host") {
      return;
    }

    const macAddress = host && host.o && host.o.mac;
    if (!macAddress) {
      return;
    }

    if (policy === false) {
      await exec(`sudo ipset -! add fw_clash_whitelist_mac ${macAddress}`).catch(() => {});
    } else {
      await exec(`sudo ipset -! del fw_clash_whitelist_mac ${macAddress}`).catch(() => {});
    }
  }

  async applyClash() {
    if (!this.ready) {
      log.info("Service clash is not ready.");
      return;
    }

    if (this.adminSystemSwitch) {
      return this.systemStart();
    } else {
      return this.systemStop();
    }
  }

  async systemStart() {
    log.info("Starting Clash at global level...");
    const entry = "server=127.0.0.1#9953\n";
    await fs.writeFileAsync(systemConfigFile, entry);
    await dnsmasq.scheduleRestartDNSService();

    await clash.redirectTraffic();
  }

  async systemStop() {
    log.info("Stopping Clash at global level...");
    await fs.unlinkAsync(systemConfigFile).catch(() => undefined);
    dnsmasq.scheduleRestartDNSService();

    await clash.stop();
  }

  // global on/off
  async globalOn(options) {
    this.adminSystemSwitch = true;
    await this.applyAll(options);
  }

  async globalOff() {
    this.adminSystemSwitch = false;
    await clash.stop();
    await this.applyClash();
  }

}

module.exports = ClashPlugin;
