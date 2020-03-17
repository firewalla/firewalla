/*    Copyright 2020 Firewalla INC 
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

const Sensor = require('./Sensor.js').Sensor;
const sem = require('../sensor/SensorEventManager.js').getInstance();
const rclient = require('../util/redis_manager.js').getRedisClient();
const fs = require('fs');
const util = require('util');
const exec = require('child-process-promise').exec
const writeFileAsync = util.promisify(fs.writeFile);

class SystemDNSSensor extends Sensor {
  constructor() {
    super();
  }

  async run() {
    sem.on('SystemDNSUpdate', async (event) => {
      let content = await rclient.getAsync('sys:dns:custom');
      if (!content) {
        content = "";
      } else {
        content += "\n";
      }
      const tmpfile = "/tmp/customDNS";
      await writeFileAsync(tmpfile, content, 'utf8');
      const profilePath = "/etc/resolvconf/resolv.conf.d/head";
      let cmd = `sudo bash -c 'cat ${tmpfile} > ${profilePath}'`;
      await exec(cmd);
      cmd = `sudo systemctl restart resolvconf`;
      await exec(cmd);
    });
  }
}

module.exports = SystemDNSSensor;
