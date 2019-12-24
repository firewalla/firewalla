/*    Copyright 2019 Firewalla Inc.
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

const log = require("./logger.js")(__filename);
const f = require('./Firewalla.js')

const { exec } = require('child-process-promise')

const PATH_NODE_CFG = `/usr/local/bro/etc/node.cfg`

class BroControl {

  async writeClusterConfig(monitoringInterfaces) {
    // rewrite cluster node.cfg
    await exec(`sudo cp -f ${f.getFirewallaHome()}/etc/node.cluster.cfg ${PATH_NODE_CFG}`)

    let workerCfg = []
    let index = 1
    for (const intf of monitoringInterfaces) {
      workerCfg.push(
        `\n`,
        `[worker-${index++}]\n`,
        `type=worker\n`,
        `host=localhost\n`,
        `interface=${intf}\n`,
      )
    }
    await exec(`echo "${workerCfg.join('')}" | sudo tee -a ${PATH_NODE_CFG}`)
  }

  async addCronJobs() {
    await exec('sudo -u pi crontab -r; sudo -u pi crontab /home/pi/firewalla/etc/crontab')
  }

  async start() {
    await exec(`sudo systemctl start brofish`)
  }

  async restart() {
    await exec(`sudo systemctl restart brofish`)
  }

}

module.exports = new BroControl
