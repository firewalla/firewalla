/*    Copyright 2020-2021 Firewalla Inc.
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
const rclient = require('../util/redis_manager.js').getRedisClient();
const fs = require('fs');
const util = require('util');
const exec = require('child-process-promise').exec
const writeFileAsync = util.promisify(fs.writeFile);
const readFileAsync = util.promisify(fs.readFile);
const existsAsync = util.promisify(fs.exists);
const extensionManager = require('./ExtensionManager.js')
const systemDNSKey = 'sys:dns:custom';
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

class SystemDNSSensor extends Sensor {
  async run() {
    sem.on('SystemDNSUpdate', async (event) => {
      this.updateSystemDNS();
    });

    this.updateSystemDNS();
  }

  async updateSystemDNS() {
    if (platform.getName() !== 'blue' && platform.getName() !== 'red') {
      return;
    }

    let oldContent = "";
    let content = await this.getSystemDNS(); // get redis
    const profilePath = "/etc/resolvconf/resolv.conf.d/head";
    const fileExists = await existsAsync(profilePath);
    if (fileExists) {
      oldContent = await readFileAsync(profilePath, {encoding: 'utf8'});
    }
    if (oldContent.trim() == content)
      return;

    if (content != "") {
      content += "\n";
    }
    const tmpfile = "/tmp/customDNS";
    await writeFileAsync(tmpfile, content, 'utf8');
    let cmd = `sudo bash -c 'cat ${tmpfile} > ${profilePath}'`;
    await exec(cmd);
    cmd = `sudo systemctl restart resolvconf`;
    await exec(cmd);
  }

  async apiRun() {
    extensionManager.onSet("systemDNS", async (msg, data) => {
      await this.setSystemDNS(data.content);
      sem.sendEventToFireMain({
        type: 'SystemDNSUpdate'
      });
    });

    extensionManager.onGet("systemDNS", async (msg, data) => {
      return this.getSystemDNS();
    });
  }

  async setSystemDNS(content) {
    if (!content) {
      content = "";
    }
    await rclient.setAsync(systemDNSKey, content);
  }

  async getSystemDNS() {
    const value = await rclient.getAsync(systemDNSKey);
    return value || "";
  }
}

module.exports = SystemDNSSensor;
