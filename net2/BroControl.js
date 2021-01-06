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
const { delay } = require('../util/util.js')

const { exec } = require('child-process-promise');
const Promise = require('bluebird');
const fs = require('fs');
Promise.promisifyAll(fs);
const _ = require('lodash');

const platform = require('../platform/PlatformLoader.js').getPlatform();

const PATH_NODE_CFG = `/usr/local/bro/etc/node.cfg`
const PATH_ADDITIONAL_OPTIONS = `${f.getUserConfigFolder()}/additional_options.bro`;

class BroControl {

  constructor() {
    this.options = {};
  }

  optionsChanged(options) {
    return !_.isEqual(options, this.options);
  }

  async writeClusterConfig(options) {
    // rewrite cluster node.cfg
    await exec(`sudo cp -f ${f.getFirewallaHome()}/etc/node.cluster.cfg ${PATH_NODE_CFG}`)

    const listenInterfaces = options.listenInterfaces || [];
    let workerCfg = []
    let index = 1
    for (const intf of listenInterfaces) {
      if (intf.endsWith(":0")) // do not listen on interface alias
        continue;
      workerCfg.push(
        `\n`,
        `[worker-${index++}]\n`,
        `type=worker\n`,
        `host=localhost\n`,
        `interface=${intf}\n`,
      )
    }
    await exec(`echo "${workerCfg.join('')}" | sudo tee -a ${PATH_NODE_CFG}`)

    const restrictFilters = options.restrictFilters || {};
    const filterEntries = [];
    for (const key in restrictFilters) {
      const filter = restrictFilters[key];
      filterEntries.push(`["${key}"] = "${filter}"`);
    }
    if (filterEntries.length > 0) {
      const content = `redef restrict_filters += [${filterEntries.join(",")}];\n`;
      await fs.writeFileAsync(PATH_ADDITIONAL_OPTIONS, content, {encoding: 'utf8'});
    } else {
      await fs.writeFileAsync(PATH_ADDITIONAL_OPTIONS, "", {encoding: 'utf8'});
    }
    this.options = options;
  }

  async addCronJobs() {
    log.info('Adding bro related cron jobs')
    await exec(`${f.getFirewallaHome()}/scripts/update_crontab.sh`)
  }

  async restart() {
    try {
      log.info('Restarting brofish..')
      await exec(`sudo systemctl restart brofish`)
    } catch (err) {
      log.error('Failed to restart brofish, will try again', err)
      await delay(5000)
      await this.restart()
    }
  }

}

module.exports = new BroControl()
