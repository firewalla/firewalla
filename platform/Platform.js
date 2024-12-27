/*    Copyright 2016-2024 Firewalla Inc.
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
const f = require('../net2/Firewalla.js');

const fs = require('fs');
const fsp = fs.promises
const cp = require('child_process');

const { exec } = require('child-process-promise');

class Platform {
  getAllNicNames() {
    // for red/blue, there is only one NIC
    return ["eth0"];
  }

  async getNicStates() {
    const nics = this.getAllNicNames();
    const result = {};
    await Promise.all(nics.map(async nic => {
      const dirExists = await fsp.access(`/sys/class/net/${nic}`, fs.constants.F_OK).then(() => true).catch(() => false);
      if (!dirExists)
        return
      const address = await fsp.readFile(`/sys/class/net/${nic}/address`, {encoding: 'utf8'}).then(result => result.trim().toUpperCase()).catch(() => "");
      let speed = await fsp.readFile(`/sys/class/net/${nic}/speed`, {encoding: 'utf8'}).then(result => result.trim()).catch(() => "");
      const carrier = await fsp.readFile(`/sys/class/net/${nic}/carrier`, {encoding: 'utf8'}).then(result => result.trim()).catch(() => "");
      let duplex = await fsp.readFile(`/sys/class/net/${nic}/duplex`, {encoding: 'utf8'}).then(result => result.trim()).catch(() => "");
      if (carrier == "0") {
        duplex = "unknown";
        speed = "-1";
      }
      result[nic] = {address, speed, carrier, duplex};
    }))
    return result;
  }

  async getMaxLinkSpeed(iface) {
    let max = 0;
    await exec(`ethtool ${iface} | tr -d '\\n' | sed -e 's/.*Supported link modes:\\(.*\\)Supported pause.*/\\1/' | xargs`).then((result) => {
      const modes = result.stdout.split(' ');
      for (const mode of modes) {
        const speed = Number(mode.split("base")[0]);
        if (speed > max)
          max = speed;
      }
    }).catch((err) => {
      log.info(`Failed to get supported link modes of ${iface}`, err.message);
    });
    return max;
  }

  getSignatureMac() {
    if (!this.signatureMac) {
      try {
        const mac = cp.execSync("cat /sys/class/net/eth0/address", {encoding: 'utf8'});
        this.signatureMac = mac && mac.trim().toUpperCase();
      } catch (err) {}
    }
    return this.signatureMac;
  }

  async getNetworkSpeed() {
    try {
      const output = await fsp.readFile(`/sys/class/net/${this.getAllNicNames[0]}/speed`, {encoding: 'utf8'});
      return output.trim();
    } catch(err) {
      log.debug('Error getting network speed', err)
      return null
    }
  }

  getDHKeySize() {
    return 1024;
  }

  getLedPaths() {
    return []
  }

  getBroProcName() {
    return "zeek";
  }

  async ledReadyForPairing() {
    try {
      for (const path of this.getLedPaths()) {
        const trigger = `${path}/trigger`;
        const brightness = `${path}/brightness`;
        await exec(`sudo bash -c 'echo default-on > ${trigger}'`);
        await exec(`sudo bash -c 'echo 255 > ${brightness}'`);
      }
    } catch(err) {
      log.error("Error set LED as ready for pairing", err)
    }
  }

  async ledPaired() {
    try {
      for (const path of this.getLedPaths()) {
        const trigger = `${path}/trigger`;
        await exec(`sudo bash -c 'echo none > ${trigger}'`);
        const brightness = `${path}/brightness`;
        await exec(`sudo bash -c 'echo 0 > ${brightness}'`);
      }
    } catch(err) {
      log.error("Error set LED as paired", err)
    }
  }

  async ledBooting() {
    try {
      for (const path of this.getLedPaths()) {
        const trigger = `${path}/trigger`;
        await exec(`sudo bash -c 'echo heartbeat > ${trigger}'`);
      }
    } catch(err) {
      log.error("Error set LED as booting", err)
    }
  }

  async switchQoS(state, qdisc) {

  }

  getDNSServiceName() {
    return "firemasq";
  }

  getDHCPServiceName() {
    return "firemasq";
  }

  getVPNServerDefaultProtocol() {
    return "udp";
  }

  getName() {}

  getBoardSerial() {}

  getLicenseTypes() {}

  getSubnetCapacity() {}

  async getCpuTemperature() {}

  getPolicyCapacity() {}

  getAllowCustomizedProfiles(){}
  getRatelimitConfig(){}

  getDHCPCapacity() {
    return true
  }

  isFireRouterManaged() {
  }

  isWireguardSupported() {
    return false;
  }

  getCronTabFile() {
    return `${f.getFirewallaHome()}/etc/crontab`;
  }

  hasMultipleCPUs() {
    return false
  }

  isBonjourBroadcastEnabled() {
    return true;
  }

  defaultPassword() {
    return null;
  }

  isBluetoothAvailable() {
    return true
  }

  isOverlayNetworkAvailable() {
    return true;
  }

  getSystemResetAllOverlayfsScriptName() {
    return "system-reset-all-overlayfs.sh";
  }

  getRetentionTimeMultiplier() {
    return 1;
  }

  getRetentionCountMultiplier() {
    return 1;
  }

  getDNSFlowRetentionTimeMultiplier() {
    return 1;
  }

  getDNSFlowRetentionCountMultiplier() {
    return 1;
  }

  getCompresseCountMultiplier(){
    return 1;
  }

  getCompresseMemMultiplier(){
    return 1;
  }

  isIFBSupported() {
    return false;
  }

  isDockerSupported() {
    return false;
  }

  isAccountingSupported() {
    return false;
  }

  isAdblockCustomizedSupported() {
    return true;
  }

  isEventsSupported() {
    return true;
  }

  isAuditLogSupported() {
    return true;
  }

  async onWanIPChanged(ip) {
    log.info("WanIP is changed to", ip);
  }

  async onVPNPortProtocolChanged() {
    log.info("VPN Port Protocol is changed");
  }

  async applyProfile() {
    log.info("NO need to apply profile");
  }

  getStatsSpecs(){
    return [];
  }

  async installTLSModule(module_name) {
    const installed = await this.isTLSModuleInstalled(module_name);
    if (installed) return;
    const codename = await exec(`lsb_release -cs`).then((result) => result.stdout.trim()).catch((err) => {
      log.error("Failed to get codename of OS distribution", err.message);
      return null;
    });
    if (!codename)
      return;

    const koPath = `${await this.getKernelModulesPath()}/${module_name}.ko`;
    const koExists = await fsp.access(koPath, fs.constants.F_OK).then(() => true).catch((err) => false);
    if (koExists)
      await exec(`sudo insmod ${koPath} max_host_sets=1024 hostset_uid=${process.getuid()} hostset_gid=${process.getgid()}`).catch((err) => {
        log.error(`Failed to install tls.ko`, err.message);
      });

    const soPath = `${await this.getSharedObjectsPath()}/lib${module_name}.so`;
    const soExists = await fsp.access(soPath, fs.constants.F_OK).then(() => true).catch((err) => false);
    if (soExists)
      await exec(`sudo install -D -v -m 644 ${soPath} /usr/lib/$(uname -m)-linux-gnu/xtables`).catch((err) => {
        log.error(`Failed to install lib${module_name}}.so`, err.message);
      });
    this.installedModules[module_name] = true;
  }
  async installTLSModules() {
    await this.installTLSModule("xt_tls");
    await this.installTLSModule("xt_udp_tls");
  }

  async isTLSModuleInstalled(module_name) {
    if (!this.installedModules) {
      this.installedModules = {};
    }
    if (this.installedModules[module_name]) {
      return this.installedModules[module_name];
    }
    const cmdResult = await exec(`lsmod | grep ${module_name} | awk '{print $1}'`);
    const results = cmdResult.stdout.toString().trim().split('\n');
    for (const result of results) {
      if (result == module_name) {
        this.installedModules[module_name] = true;
        return true;
      }
    }
    return false;
  }

  isTLSBlockSupport() {
    return false;
  }

  async getKernelModulesPath() {
    const kernelRelease = await exec("uname -r").then(result => result.stdout.trim());
    return `${this.getPlatformFilesPath()}/kernel_modules/${kernelRelease}`;
  }

  async getSharedObjectsPath() {
    const codename = await exec(`lsb_release -cs`).then((result) => result.stdout.trim());
    return `${this.__dirname}/files/shared_objects/${codename}`;
  }

  getDnsmasqBinaryPath() {
    if(!this.dnsmasqBinary) {
      const bin = `${f.getRuntimeInfoFolder()}/dnsmasq`;
      const exists = fs.existsSync(bin);
      if(exists) {
        this.dnsmasqBinary = bin;
      } else {
        this.dnsmasqBinary = this._getDnsmasqBinaryPath();
      }
    }

    return this.dnsmasqBinary;
  }

  _getDnsmasqBinaryPath() { }

  getDnsproxySOPath() { }

  getPlatformFilesPath() { return `${this.__dirname}/files` }

  getZeekPcapBufsize() {
    return {
      eth: 32,
      tun_fwvpn: 32,
      wg: 32,
      wlan: 32,
    }
  }

  getSuricataYAMLPath() {
    return `${this.__dirname}/files/suricata.yaml`
  }

  async configFan(policy) {
    log.info("Fan configuration NOT supported");
  }

  async configLEDs(policy) {
    log.info("LED configuration NOT supported");
  }

  async updateLEDDisplay(systemState) {
    log.info("Update LED display based on system state - NOT supported");
    log.info("systemState:",systemState);
  };

  getSpeedtestCliBinPath() {
    
  }

  async getWlanVendor() {
    return '';
  }

  async getVariant() {
    return '';
  }

  getDefaultWlanIntfName() {
    return null
  }

  async ledSaving() {
  }

  async ledDoneSaving() {
  }

  async ledStartResetting() {
  }

  async ledNetworkDown() {

  }

  async ledNetworkUp() {

  }

  async getFanSpeed() {
      return "-1"
  }

  supportSSHInNmap() {
    return true;
  }

  getSSHPasswdFilePath() {
    return `${f.getHiddenFolder()}/.sshpassword`;
  }

  hasDefaultSSHPassword() {
    return true;
  }

  openvpnFolder() {
    return "/etc/openvpn";
  }

  getDnsmasqLeaseFilePath() {
    return `${f.getHiddenFolder()}/run/dnsmasq.leases`;
  }

  async reloadActMirredKernelModule() {
    const koPath = `${await this.getKernelModulesPath()}/act_mirred.ko`;
    const koExists = await fsp.access(koPath, fs.constants.F_OK).then(() => true).catch(() => false);
    if (koExists) {
      log.info("Reloading act_mirred.ko...");
      try {
        const loaded = await exec(`sudo lsmod | grep act_mirred`).then(() => true).catch(() => false);
        if (loaded)
          await exec(`sudo rmmod act_mirred`);
        await exec(`sudo insmod ${koPath}`);
      } catch (err) {
        log.error("Failed to reload act_mirred.ko", err.message);
      }
    }
  }

  isNicCalibrationApplicable() {
    return false;
  }

  async isNicCalibrationHWEnabled() {
    return false;
  }

  async getNicCalibrationHWParams() {
    return null;
  }

  async setNicCalib(param) {

  }

  async resetNicCalib() {

  }

  async getReleaseHash() {
    const result = await exec('cat /etc/firewalla_release | grep HASH | cut -d: -f2 | xargs echo -n')
    return result.stdout
  }

  supportOSI() {
    return true;
  }

  isDNSFlowSupported() { return false }
}

module.exports = Platform;
