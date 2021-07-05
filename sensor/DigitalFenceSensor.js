/*    Copyright 2016-2020 Firewalla Inc.
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

const cp = require('child_process');
const spawn = cp.spawn;
const util = require('util');
const execAsync = util.promisify(cp.exec);
const f = require('../net2/Firewalla.js');
const extensionManager = require('./ExtensionManager.js')

const wifiKey = "digitalfence:nearby:wifi";
const bluetoothKey = "digitalfence:nearby:bluetooth";
const keyPattern = "digitalfence:nearby:*"

const rclient = require('../util/redis_manager.js').getRedisClient()
const _ = require('lodash');

class DigitalFenceSensor extends Sensor {

  async apiRun() {

    extensionManager.onGet("digitalfence", async () => {
      const keys = await rclient.keysAsync(keyPattern);
      const rst = {};
      await Promise.all(keys.map( async key => {
        const value = await this.getObjByKey(key);
        rst[key] = value;        
      }))
      return rst;
    });

  }

  async getObjByKey(key) {
    const rst = {};
    try {
      const devices = await rclient.zrevrangeAsync(key, 0, -1);
      for (const device of devices) {
        const dObj = JSON.parse(device);
        for (const key in dObj) {
          rst[key] = dObj[key];
        }
      }
    } catch (err) {
      log.error(`get key ${key} failed`, err);
    }
    return rst;
  }

  run() {
    (async () => {
      await this.wifi();
      // this.bluetooth();
    })();
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

  async wifi() {
    const setWlanMonitorCmd = "sudo iwconfig wlan0 mode monitor"
    await execAsync(setWlanMonitorCmd).catch((err) => { log.error(`Failed to set monitor mode`, err);});
    const awkFile = `${f.getFirewallaHome()}/scripts/parse-tcpdump.awk`
    const tcpdump = spawn('sudo', ['tcpdump', '-i', 'wlan0', '-e', '-s', '256', 'type mgt subtype probe-req']);
    const awk = spawn('awk', ['-f', awkFile])

    tcpdump.stdout.on('data', data => awk.stdin.write(data));
    tcpdump.stderr.on('data', data => log.error(`tcpdump stderr: ${data}`));

    tcpdump.on('close', (code) => {
      if (code !== 0) {
        log.info(`tcpdump process exited with code ${code}`);
      }
      awk.stdin.end();
    });

    awk.stdout.on('data', async (data) => {
      const content = data.toString();
      const lines = content.split('\n')
      if (!lines) return;
      for (const line of lines) {
        if (line) {
          const params = line.split(" ", 3);
          if (params.length < 3) {
            continue;
          }
          const mac = params[2];
          const sid = line.substring(line.indexOf(mac)+mac.length).trim();
          const value = {};
          value[mac] = sid;
          await rclient.zaddAsync(wifiKey, Math.floor(new Date() / 1000), JSON.stringify(value));
        }
      }
    });

    awk.stderr.on('data', (data) => log.error(`awk stderr: ${data}`));
    awk.on('close', (code) => {
      if (code !== 0) {
        log.info(`awk process exited with code ${code}`);
      }
    });
  }

}

module.exports = DigitalFenceSensor;