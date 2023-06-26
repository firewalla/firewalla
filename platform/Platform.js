/*    Copyright 2016-2022 Firewalla Inc.
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
    for (const nic of nics) {
      const dirExists = await fsp.access(`/sys/class/net/${nic}`, fs.constants.F_OK).then(() => true).catch(() => false);
      if (!dirExists)
        continue;
      const address = await fsp.readFile(`/sys/class/net/${nic}/address`, {encoding: 'utf8'}).then(result => result.trim().toUpperCase()).catch(() => "");
      let speed = await fsp.readFile(`/sys/class/net/${nic}/speed`, {encoding: 'utf8'}).then(result => result.trim()).catch(() => "");
      const carrier = await fsp.readFile(`/sys/class/net/${nic}/carrier`, {encoding: 'utf8'}).then(result => result.trim()).catch(() => "");
      let duplex = await fsp.readFile(`/sys/class/net/${nic}/duplex`, {encoding: 'utf8'}).then(result => result.trim()).catch(() => "");
      if (carrier == "0") {
        duplex = "unknown";
        speed = "-1";
      }
      result[nic] = {address, speed, carrier, duplex};
    }
    return result;
  }

  async getMaxLinkSpeed(iface) {
    let max = 0;
    await exec(`ethtool ${iface} | tr -d '\\n' | sed -e 's/.*Supported link modes:\\(.*\\)Supported pause.*/\\1/' | xargs`).then((result) => {
      const modes = result.stdout.split(' ');
      for (const mode of modes) {
        const speed = mode.split("base")[0];
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

  async installTLSModule() {}

  isTLSBlockSupport() {
    return false;
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
    // do nothing by default
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
}

module.exports = Platform;
