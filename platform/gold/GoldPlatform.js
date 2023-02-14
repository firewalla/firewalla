/*    Copyright 2019-2022 Firewalla Inc.
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
const f = require('../../net2/Firewalla.js')
const exec = require('child-process-promise').exec;
const fs = require('fs').promises; // available after Node 10
const log = require('../../net2/logger.js')(__filename);
const ipset = require('../../net2/Ipset.js');
const { execSync } = require('child_process');

class GoldPlatform extends Platform {
  constructor() {
    super()
    this.__dirname = __dirname
  }

  getName() {
    return "gold";
  }

  getLicenseTypes() {
    return ["b1", "b2"];
  }

  getAllNicNames() {
    // there are four ethernet NICs and at most two wlan NICs on gold
    return ["eth0", "eth1", "eth2", "eth3", "wlan0", "wlan1"];
  }

  getDHCPServiceName() {
    return "firerouter_dhcp";
  }

  getDHKeySize() {
    if (this.isUbuntu18()) {
      return 1024;
    } else {
      return 2048;
    }
  }

  getDNSServiceName() {
    return "firerouter_dns";
  }

  getBoardSerial() {
    // use mac address as unique serial number
    return this.getSignatureMac();
  }

  getB4Binary() {
    return `${f.getFirewallaHome()}/bin/real.x86_64/bitbridge7`;
  }

  getB6Binary() {
    return `${f.getFirewallaHome()}/bin/real.x86_64/bitbridge6`;
  }

  getGCMemoryForMain() {
    return 200;
  }

  getLedPaths() {
    return [
      // "/sys/devices/platform/leds/leds/nanopi:green:status",
//      "/sys/devices/platform/leds/leds/nanopi:red:pwr"
    ];
  }

  getLSBCodeName() {
    return execSync("lsb_release -cs", {encoding: 'utf8'}).trim();
  }

  isUbuntu18() {
    return this.getLSBCodeName() === 'bionic';
  }

  isUbuntu20() {
    return this.getLSBCodeName() === 'focal';
  }

  isUbuntu22() {
    return this.getLSBCodeName() === 'jammy';
  }

  async ledReadyForPairing() {
    try {
      for (const path of this.getLedPaths()) {
        const trigger = `${path}/trigger`;
        const brightness = `${path}/brightness`;
        await exec(`sudo bash -c 'echo none > ${trigger}'`);
        await exec(`sudo bash -c 'echo 255 > ${brightness}'`);
      }
    } catch(err) {
      log.error("Error set LED as ready for pairing", err)
    }
  }

  async switchQoS(state, qdisc) {
    if (state == false) {
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4}`).catch((err) => {
        log.error(`Failed to add ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4} to ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6}`).catch((err) => {
        log.error(`Failed to add ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6} to ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
    } else {
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4}`).catch((err) => {
        log.error(`Failed to remove ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4} from ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6}`).catch((err) => {
        log.error(`Failed to remove ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6} from ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
    }
    const supported = await exec(`modinfo sch_${qdisc}`).then(() => true).catch((err) => false);
    if (!supported) {
      log.error(`qdisc ${qdisc} is not supported`);
      return;
    }
    // replace the default root qdisc
    await exec(`sudo tc qdisc replace dev ifb0 parent 1:1 ${qdisc}`).catch((err) => {
      log.error(`Failed to update root qdisc on ifb0`, err.message);
    });
    await exec(`sudo tc qdisc replace dev ifb1 parent 1:1 ${qdisc}`).catch((err) => {
      log.error(`Failed to update root qdisc on ifb1`, err.message);
    });
  }

  getSubnetCapacity() {
    return 18;
  }

  hasMultipleCPUs() {
    return true
  }

  async getCpuTemperature() {
    try {
      const path = '/sys/class/hwmon/hwmon1/'
      const tempList = []
      const dir = await fs.opendir(path)
      for await (const dirent of dir) {
        if (dirent.name.match(/temp(\d+)_input/)) {
          const input = await fs.readFile(path + dirent.name, 'utf8')
          tempList.push(Number(input) / 1000)
        }
      }
      return tempList
    } catch(err) {
      log.error("Failed to get cpu temperature, use 0 as default, err:", err);
      return 0;
    }
  }

  getDefaultWlanIntfName() {
    return 'wlan0'
  }

  getPolicyCapacity() {
    return 3000;
  }

  getDHCPCapacity() {
    return false
  }

  isFireRouterManaged() {
    return true;
  }

  isWireguardSupported() {
    return true;
  }

  getCronTabFile() {
    return `${f.getFirewallaHome()}/etc/crontab.gold`;
  }
  getAllowCustomizedProfiles(){
    return 10;
  }
  getRatelimitConfig(){
    return {
      "appMax": 240,
      "webMax": 480,
      "duration": 60
    }
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

  isAccountingSupported() {
    return true;
  }

  async applyProfile() {
    try {
      log.info("apply profile to optimize performance");
      await exec(`sudo ${f.getFirewallaHome()}/scripts/apply_profile.sh`);
    } catch(err) {
      log.error("Error applying profile", err)
    }
  }

  getStatsSpecs() {
    return [{
      granularities: '1hour',
      hits: 72,
      stat: '3d'
    }]
  }

  async installTLSModule() {
    const installed = await this.isTLSModuleInstalled();
    if (installed) return;
    let TLSmodulePathPrefix = null;
    if (this.isUbuntu20()) {
      TLSmodulePathPrefix = __dirname+"/files/TLS/u20";
    } else if (this.isUbuntu22()) {
      TLSmodulePathPrefix = __dirname+"/files/TLS/u22";
    } else {
      TLSmodulePathPrefix = __dirname+"/files/TLS/u18";
    }
    await exec(`sudo insmod ${TLSmodulePathPrefix}/xt_tls.ko max_host_sets=1024 hostset_uid=${process.getuid()} hostset_gid=${process.getgid()}`);
    await exec(`sudo install -D -v -m 644 ${TLSmodulePathPrefix}/libxt_tls.so /usr/lib/x86_64-linux-gnu/xtables`);
  }

  async isTLSModuleInstalled() {
    if (this.tlsInstalled) return true;
    const cmdResult = await exec(`lsmod| grep xt_tls| awk '{print $1}'`);
    const results = cmdResult.stdout.toString().trim().split('\n');
    for(const result of results) {
      if (result == 'xt_tls') {
        this.tlsInstalled = true;
        break;
      }
    }
    return this.tlsInstalled;
  }

  isTLSBlockSupport() {
    return true;
  }

  _getDnsmasqBinaryPath() {
    return `${__dirname}/files/dnsmasq`;
  }

  getDnsproxySOPath() {
    return `${__dirname}/files/libdnsproxy.so`
  }

  getSpeedtestCliBinPath() {
    return `${f.getRuntimeInfoFolder()}/assets/speedtest`
  }

  getSSHPasswdFilePath() {
    // this directory will be flushed over the reboot, which is consistent with /etc/passwd in root partition
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

  async reloadActMirredKernelModule() {

    // To test this new kernel module, only enable in dev/alpha/beta branch
    // To enable it for all branches, need to change both here and the way how br_netfilter is loaded in net2/FireRouter.js
    if (this.isUbuntu22() && !f.isProduction() ) {
      log.info("Reloading act_mirred.ko...");
      try {
        const loaded = await exec(`sudo lsmod | grep act_mirred`).then(result => true).catch(err => false);
        if (loaded)
          await exec(`sudo rmmod act_mirred`);
        await exec(`sudo insmod ${__dirname}/files/$(uname -r)/act_mirred.ko`);
      } catch(err) {
        log.error("Failed to unload act_mirred, err:", err.message);
      }
    }
  }
}

module.exports = GoldPlatform;
