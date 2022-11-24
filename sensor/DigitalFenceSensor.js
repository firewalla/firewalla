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

const Sensor = require('./Sensor.js').Sensor;
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Message = require('../net2/Message.js');

const cp = require('child_process');
const spawn = cp.spawn;
const util = require('util');
const execAsync = util.promisify(cp.exec);
const f = require('../net2/Firewalla.js');
const extensionManager = require('./ExtensionManager.js')
const FireRouter = require('../net2/FireRouter.js');

const wifiKeyPrefix = "digitalfence:wifi:";
const bluetoothKey = "digitalfence:bluetooth:";
const wifiCache = {}
const featureName = "digitalfence"

const rclient = require('../util/redis_manager.js').getRedisClient()

class DigitalFenceSensor extends Sensor {

  async apiRun() {

    extensionManager.onGet("digitalfence", async () => {
      const wifiRst = {};
      const bluetoothRst = {};
      const keys = await rclient.scanResults("digitalfence:*");
      await Promise.all(keys.map( async key => {
        const value = await rclient.hgetallAsync(key);
        if (key.includes("wifi")) {
          wifiRst[key] = value;
        }
        if (key.includes("bluetooth")) {
          bluetoothRst[key] = value;
        }
      }))
      return {"wifi": wifiRst, "bluetooth": bluetoothRst};
    });
  }

  run() {
    this.hookFeature(featureName);
    sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, async () => {
      if (!this.isSwitchOn) {
        return;
      }
      const nowAvailableWifiInf = await this._getAvailableWifiInf();
      if (!nowAvailableWifiInf && this.wifiAvailableInf) {
        await this.disableDetectNearbyWifiDevice(this.wifiAvailableInf);
      }
      if (nowAvailableWifiInf && this.wifiAvailableInf != nowAvailableWifiInf) {
        if (this.wifiAvailableInf) {
          await this.disableDetectNearbyWifiDevice(this.wifiAvailableInf);
        }
        await this.enableDetectNearbyWifiDevice(nowAvailableWifiInf);
        this.wifiAvailableInf = nowAvailableWifiInf;
      }
    })
  }

  bluetooth() {
    const bluetoothctl = spawn('sudo', ['bluetoothctl']);
    bluetoothctl.stdout.on('data', async (data) => {
      const content = data.toString().trim();
      const lines = content.split('\n');
      if (!lines) return;
      for (const line of lines) {
        if (line) {
          if (line.includes("NEW")) {
            const subline = line.substring(line.indexOf("NEW")).trim();
            const params = subline.split(" ", 3);
            if (params.length < 3) {
              continue;
            }
            const mac = params[2];
            const device = subline.substring(subline.indexOf(mac)+mac.length).trim();
            const value = {};
            value[mac] = device;
            await rclient.zaddAsync(bluetoothKey, Math.floor(new Date() / 1000), JSON.stringify(value));
          }
        }
      }
    });
    bluetoothctl.stderr.on('data', data => log.error(`bluetoothctl stderr: ${data}`));
    setTimeout(() => {
      bluetoothctl.stdin.write('scan on\n');
    }, 2000);
  }

  _getProbeReqTs(ts) {
    return Math.floor(new Date(ts).getTime() / 1000);
  }

  async _process(data) {
    const content = data.toString();
    const lines = content.split('\n')
    if (!lines) return;
    for (const line of lines) {
      if (line) {
        const params = line.split(" ", 4);
        if (params.length < 4) {
          continue;
        }
        const ts = this._getProbeReqTs(params[0] + " " + params[1]);
        const mac = params[3];
        const sid = line.substring(line.indexOf(mac)+mac.length).trim();
        const tsPre = wifiCache[mac+sid];
        if (tsPre && ts - tsPre < 5) {
          wifiCache[mac+sid] = ts;
          continue;
        }
        wifiCache[mac+sid] = ts;
        const value = {};
        value[mac] = sid;
        try {
          const sidStr = await rclient.hgetAsync(wifiKeyPrefix + mac, 'sid');
          if (!sidStr) {
            await rclient.hsetAsync(wifiKeyPrefix + mac, 'sid', JSON.stringify([sid]));  
          } else {
            const sids = JSON.parse(sidStr);
            if (!sids.includes(sid)) {
              sids.push(sid);
            }
            await rclient.hsetAsync(wifiKeyPrefix + mac, 'sid', JSON.stringify(sids));
          }
          const fts = await rclient.hgetAsync(wifiKeyPrefix + mac, 'firstSeenTimestamp');
          if (!fts) {
            await rclient.hsetAsync(wifiKeyPrefix + mac, 'firstSeenTimestamp', ts);
          }
          await rclient.hsetAsync(wifiKeyPrefix + mac, 'lastActiveTimestamp', ts);
        } catch (err) {
          log.error("save error", err);
        }
      }
    }
  }

  async _getAvailableWifiInf() {
    const networks = await FireRouter.getInterfaceAll();
    const wifiInfOutput = await execAsync("ls -d /sys/class/net/*/phy80211 | awk -F/ '{print $5}'").then(result => result.stdout.trim()).catch(() => null);
    const wifiInfs = wifiInfOutput.split('\n')
    for (const wifiInf of wifiInfs) {
      if (!networks[wifiInf] || !networks[wifiInf]["config"] || !networks[wifiInf]["config"]["enabled"]) {
        return wifiInf;
      }
    }
  }

  _getWlanModeCmd(inf, mode) {
    return `sudo iwconfig ${inf} mode ${mode}`
  }

  async enableDetectNearbyWifiDevice(inf) {
    log.info("enabled wifi inf name is: ", inf)
    const setWlanMonitorCmd = this._getWlanModeCmd(inf, "monitor")
    const r = await execAsync(setWlanMonitorCmd)
    .then(() => {
      return true;
    })
    .catch((err) => {
      log.error(`Failed to set monitor mode`, err);
      return false;
    });
    if (!r) {
      return;
    }
    const awkFile = `${f.getFirewallaHome()}/scripts/parse-tcpdump.awk`
    const tcpdump = spawn('sudo', ['tcpdump', '-i', inf, '-e', '-s', '256', 'type mgt subtype probe-req']);
    this.tcpdumpPid = tcpdump.pid;
    const awk = spawn('awk', ['-f', awkFile])

    tcpdump.stdout.on('data', data => awk.stdin.write(data));
    tcpdump.stderr.on('data', data => log.error(`tcpdump stderr: ${data}`));
    tcpdump.on('close', (code) => {
      if (code !== 0) {
        log.info(`tcpdump process exited with code ${code}`);
      }
      awk.stdin.end();
    });

    awk.stdout.on('data', async (data) => { await this._process(data)});
    awk.stderr.on('data', (data) => log.error(`awk stderr: ${data}`));
    awk.on('close', (code) => {
      if (code !== 0) {
        log.info(`awk process exited with code ${code}`);
      }
    });
  }

  async disableDetectNearbyWifiDevice(inf) {
    const setWlanDefaultCmd = this._getWlanModeCmd(inf, "managed")
    await execAsync(setWlanDefaultCmd).catch((err) => { log.error(`Failed to set default mode`, err);});
    if (this.tcpdumpPid) {
      const cPid = await execAsync(`ps -ef| grep tcpdump| awk '$3 == '${this.tcpdumpPid}' { print $2 }'`).then(result => result.stdout.trim()).catch(() => null);
      await execAsync(`sudo kill -9 ${cPid}`).catch((err) => { log.error(`kill pid ${cPid} failed`, err) });
    }
  }

  async globalOn() {
    this.isSwitchOn = true;
    this.wifiAvailableInf = await this._getAvailableWifiInf();
    if (this.wifiAvailableInf) {
      await this.enableDetectNearbyWifiDevice(this.wifiAvailableInf);
    }
  }

  async globalOff() {
    this.isSwitchOn = false;
    if (this.wifiAvailableInf) {
      await this.disableDetectNearbyWifiDevice(this.wifiAvailableInf);
    }
  }
}

module.exports = DigitalFenceSensor;
