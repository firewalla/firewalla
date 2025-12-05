/*    Copyright 2019-2024 Firewalla Inc.
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
const firestatusBaseURL = "http://127.0.0.1:9966";
const f = require('../../net2/Firewalla.js')
const exec = require('child-process-promise').exec;
const fs = require('fs');
const fsp = require('fs').promises;
const log = require('../../net2/logger.js')(__filename);
const ipset = require('../../net2/Ipset.js');
const rp = require('request-promise');
const { execSync } = require('child_process');

class GoldProPlatform extends Platform {
  constructor() {
    super()
    this.__dirname = __dirname
  }

  getName() {
    return "goldpro";
  }

  getLicenseTypes() {
    return ["g1"];
  }

  getAllNicNames() {
    // there are four ethernet NICs and at most two wlan NICs on gold
    return ["eth0", "eth1", "eth2", "eth3", "wlan0", "wlan1"];
  }

  getDHCPServiceName() {
    return "firerouter_dhcp";
  }

  getDHKeySize() {
    return 2048
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

  getLSBCodeName() {
    return execSync("lsb_release -cs", {encoding: 'utf8'}).trim();
  }

  isUbuntu22() {
    return this.getLSBCodeName() === 'jammy';
  }

  async ledReadyForPairing() {
    await rp(`${firestatusBaseURL}/fire?name=firekick&type=ready_for_pairing`).catch((err) => {
      log.error("Failed to set LED as ready for pairing, err:", err.message);
    });
  }

  async ledPaired() {
    await rp(`${firestatusBaseURL}/resolve?name=firekick&type=ready_for_pairing`).catch((err) => {
      log.error("Failed to set LED as paired, err:", err.message);
    });
  }

  async ledSaving() {
    await rp(`${firestatusBaseURL}/fire?name=nodejs&type=writing_disk`).catch((err) => {
      log.error("Failed to set LED as saving, err:", err.message);
    });
  }

  async ledDoneSaving() {
    await rp(`${firestatusBaseURL}/resolve?name=nodejs&type=writing_disk`).catch((err) => {
      log.error("Failed to set LED as done saving, err:", err.message);
    });
  }

  async ledStartResetting() {
    await rp(`${firestatusBaseURL}/fire?name=nodejs&type=reset`).catch((err) => {
      log.error("Failed to set LED as resetting, err:", err.message);
    });
  }

  async ledNetworkDown() {
    await rp(`${firestatusBaseURL}/fire?name=nodejs&type=network_down`).catch((err) => {
      log.error("Failed to set LED as network down, err:", err.message);
    });
  }

  async ledNetworkUp() {
    await rp(`${firestatusBaseURL}/resolve?name=nodejs&type=network_down`).catch((err) => {
      log.error("Failed to set LED as network up, err:", err.message);
    });
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
    // replace the default tc filter
    const QoS = require('../../control/QoS.js');
    const parent_classid = 10;
    await exec (`sudo tc filter replace dev ifb0 parent ${parent_classid}: handle 800::0x1 prio 1 u32 match mark 0x800000 0x${QoS.QOS_UPLOAD_MASK.toString(16)} flowid ${parent_classid}:${qdisc == "fq_codel" ? 5 : 6}`).catch((err) => {
      log.error(`Failed to update tc filter on ifb0`, err.message);
    });
    await exec (`sudo tc filter replace dev ifb1 parent ${parent_classid}: handle 800::0x1 prio 1 u32 match mark 0x10000 0x${QoS.QOS_DOWNLOAD_MASK.toString(16)} flowid ${parent_classid}:${qdisc == "fq_codel" ? 5 : 6}`).catch((err) => {
      log.error(`Failed to update tc filter on ifb1`, err.message);
    });
  }

  async setQoSBandwidth(upload, download) {
    if (upload > 0 && download > 0) {
      upload = Math.floor(upload * 0.98); // leave some margin
      download = Math.floor(download * 0.98); // leave some margin

      const upload_burst = Math.floor(upload * 1024 / 800); // in KB
      const download_burst = Math.floor(download * 1024 / 800); // in KB


      await exec (`sudo tc class replace dev ifb0 parent 1: classid 1:1 htb rate ${upload}mbit ceil ${upload}mbit burst ${upload_burst}kbit cburst ${upload_burst}kbit`).catch((err) => {
        log.error(`Failed to set upload bandwidth to ${upload}mbit`, err.message);
      });
      await exec (`sudo tc class replace dev ifb1 parent 1: classid 1:1 htb rate ${download}mbit ceil ${download}mbit burst ${download_burst}kbit cburst ${download_burst}kbit`).catch((err) => {
        log.error(`Failed to set download bandwidth to ${download}mbit`, err.message);
      });
    }
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
      const dir = await fsp.opendir(path)
      for await (const dirent of dir) {
        if (dirent.name.match(/temp(\d+)_input/)) {
          const input = await fsp.readFile(path + dirent.name, 'utf8')
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
      "streamingMax": 480,
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

  getDNSFlowRetentionTimeMultiplier() {
    return 24;
  }

  getDNSFlowRetentionCountMultiplier() {
    return 10;
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

  isDNSFlowSupported() { return true }
}

module.exports = GoldProPlatform;
