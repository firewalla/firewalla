/*    Copyright 2016-2026 Firewalla Inc.
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

const Platform = require('../Platform.js');
const f = require('../../net2/Firewalla.js');
const exec = require('child-process-promise').exec;
const fs = require('fs');
const log = require('../../net2/logger.js')(__filename);
const { execSync } = require('child_process');

class CrystalPlatform extends Platform {
  constructor() {
    super();
    this.__dirname = __dirname;
  }

  getName() {
    return "crystal";
  }

  // TODO: persistent device identity (UUID) for license binding; approach/persist location TBD
  getBoardSerial() {
  }

  // TODO: confirm the real license type string(s) with the license/cloud team
  getLicenseTypes() {
    return [];
  }

  // physical NICs are dynamic on Crystal; enumerate what's actually present
  getAllNicNames() {
    try {
      return fs.readdirSync('/sys/class/net').filter(nic => /^eth\d+$/.test(nic)).sort();
    } catch (err) {
      log.error(`Failed to enumerate NICs from /sys/class/net, falling back to defaults: ${err.message}`);
      return ["eth0", "eth1"];
    }
  }

  // === x86 software capabilities (Referred to goldpro) =====

  isFireRouterManaged() {
    return true;
  }

  getDNSServiceName() {
    return "firerouter_dns";
  }

  getDHCPServiceName() {
    return "firerouter_dhcp";
  }

  getDHKeySize() {
    return 2048;
  }

  getB4Binary() {
    return `${f.getFirewallaHome()}/bin/real.x86_64/bitbridge7`;
  }

  getB6Binary() {
    return `${f.getFirewallaHome()}/bin/real.x86_64/bitbridge6`;
  }

  getGCMemoryForMain() {
    return 350;
  }

  getLSBCodeName() {
    return execSync("lsb_release -cs", { encoding: 'utf8' }).trim();
  }

  getSubnetCapacity() {
    return 18;
  }

  hasMultipleCPUs() {
    return true;
  }

  getPolicyCapacity() {
    return 3000;
  }

  getExceptionCapacity() {
    return 3000;
  }

  getDHCPCapacity() {
    return false;
  }

  isWireguardSupported() {
    return true;
  }

  isAmneziaWgSupported() {
    return true;
  }

  getCronTabFile() {
    return `${f.getFirewallaHome()}/etc/crontab.crystal`;
  }

  getAllowCustomizedProfiles() {
    return 10;
  }

  getRatelimitConfig() {
    return {
      "appMax": 240,
      "webMax": 480,
      "streamingMax": 480,
      "duration": 60
    };
  }

  isBonjourBroadcastEnabled() {
    return false;
  }

  isOverlayNetworkAvailable() {
    return false;
  }

  isIFBSupported() {
    return true;
  }

  isDockerSupported() {
    return true;
  }

  getDNSFlowRetentionTimeMultiplier() {
    return 24;
  }

  getDNSFlowRetentionCountMultiplier() {
    return 10;
  }

  isAccountingSupported() {
    return true;
  }

  async applyProfile() {
    try {
      log.info("apply profile to optimize performance");
      await exec(`sudo ${f.getFirewallaHome()}/scripts/apply_profile.sh`);
    } catch (err) {
      log.error("Error applying profile", err);
    }
  }

  getStatsSpecs() {
    return [{
      granularities: '1hour',
      hits: 72,
      stat: '3d'
    }];
  }

  isTLSBlockSupport() {
    return true;
  }

  isDNSFlowSupported() {
    return true;
  }

  _getDnsmasqBinaryPath() {
    return `${__dirname}/files/dnsmasq`;
  }

  getDnsproxySOPath() {
    return `${__dirname}/files/libdnsproxy.so`;
  }

  getSpeedtestCliBinPath() {
    return `${f.getRuntimeInfoFolder()}/assets/speedtest`;
  }

  getSSHPasswdFilePath() {
    // flushed over reboot, consistent with /etc/passwd in root partition
    return `/dev/shm/.sshpassword`;
  }

  hasDefaultSSHPassword() {
    return false;
  }

  openvpnFolder() {
    return "/home/pi/openvpn";
  }

  getDnsmasqLeaseFilePath() {
    return `${f.getFireRouterRuntimeInfoFolder()}/dhcp/dnsmasq.leases`;
  }

  // === Intentionally NOT overridden (inherit base no-ops) =====================
  // LED:          getLedPaths()/ledReadyForPairing()/ledPaired()/ledBooting()/...
  // Temperature:  getCpuTemperature()/getFanSpeed()/configFan()
  // WiFi:         getDefaultWlanIntfName() (-> null), getWlanVendor()
  // NIC calib:    isNicCalibrationApplicable()/setNicCalib()/...
  // Crystal has no LEDs, no temperature sensors, no fan, and no guaranteed WiFi,
  // so the base safe defaults are exactly what we want.
}

module.exports = CrystalPlatform;
