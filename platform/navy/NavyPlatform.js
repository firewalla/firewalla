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

const Platform = require('../Platform.js');
const f = require('../../net2/Firewalla.js')
const exec = require('child-process-promise').exec;
const log = require('../../net2/logger.js')(__filename);
const sem = require('../../sensor/SensorEventManager.js').getInstance();
const Message = require('../../net2/Message.js');

const fs = require('fs');
const util = require('util');
const readFileAsync = util.promisify(fs.readFile)

class NavyPlatform extends Platform {
  constructor() {
    super()
    this.__dirname = __dirname
  }

  getName() {
    return "navy";
  }

  getLicenseTypes() {
    return ["a3"];
  }

  getBoardSerial() {
    // use mac address as unique serial number
    return this.getSignatureMac();
  }

  getB4Binary() {
    return `${f.getFirewallaHome()}/bin/real.navy/bitbridge7`;
  }

  getB6Binary() {
    return `${f.getFirewallaHome()}/bin/real.navy/bitbridge6`;
  }

  getGCMemoryForMain() {
    return 200;
  }

  getDHKeySize() {
    return 2048;
  }

  getLedPaths() {
    return [
      "/sys/devices/platform/gpio-leds/leds/status_led"
    ];
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
    const supported = await exec(`modinfo sch_${qdisc}`).then(() => true).catch((err) => false);
    if (!supported) {
      log.error(`qdisc ${qdisc} is not supported`);
      return;
    }
    if (state == true) {
      await exec(`sudo tc qdisc replace dev eth0 root ${qdisc}`).catch((err) => {
        log.error(`Failed to replace qdisc on eth0 with ${qdisc}`, err.message);
      });
    } else {
      await exec(`sudo tc qdisc del dev eth0 root`).catch((err) => {
        log.error(`Failed to remove qdisc on eth0`, err.message);
      });
    }
  }

  getSubnetCapacity() {
    return 19;
  }

  // via /etc/update-motd.d/30-armbian-sysinfo
  async getCpuTemperature() {
    try {
      const source = '/sys/class/thermal/thermal_zone0/temp';
      return Number(await readFileAsync(source)) / 1000;
    } catch(err) {
      log.error("Failed to get cpu temperature, use 0 as default, err:", err);
      return 0;
    }
  }

  getPolicyCapacity() {
    return 3000;
  }

  isFireRouterManaged() {
    return false;
  }

  isWireguardSupported() {
    return true;
  }

  getAllowCustomizedProfiles(){
    return 1;
  }
  getRatelimitConfig(){
    return {
      "appMax": 120,
      "webMax": 240,
      "duration": 60
    }
  }

  defaultPassword() {
    return "firewalla"
  }

  /*
  getSystemResetAllOverlayfsScriptName() {
    return "system-reset-all-overlayfs-navy.sh";
  }
  */

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

  async onWanIPChanged(ip) {
    await super.onWanIPChanged(ip)
    // trigger pcap tool restart to adopt new WAN IP for VPN filter
    sem.emitLocalEvent({type: Message.MSG_PCAP_RESTART_NEEDED});
  }

  isAccountingSupported() {
    return true;
  }

  async applyProfile() {
    try {
      log.info("apply profile to optimize network performance");
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
    }];
  }

  async installTLSModule() {
    const installed = await this.isTLSModuleInstalled();
    if (installed) return;
    await exec(`sudo insmod ${__dirname}/files/xt_tls.ko max_host_sets=1024 hostset_uid=${process.getuid()} hostset_gid=${process.getgid()}`);
    await exec(`sudo install -D -v -m 644 ${__dirname}/files/libxt_tls.so /usr/lib/aarch64-linux-gnu/xtables`);
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

  supportOSI() {
    return false;
  }
}

module.exports = NavyPlatform;
