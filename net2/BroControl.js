/*    Copyright 2019-2021 Firewalla Inc.
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
const BRO_PROC_NAME = platform.getBroProcName();

const PATH_NODE_CFG = `/usr/local/${BRO_PROC_NAME}/etc/node.cfg`
const PATH_ADDITIONAL_OPTIONS = `${f.getUserConfigFolder()}/additional_options.bro`;
const PATH_LOCAL_NETWORK_CFG = `/usr/local/${BRO_PROC_NAME}/etc/networks.cfg`;
const PATH_WORKER_SCRIPTS = `${f.getRuntimeInfoFolder()}/zeek/scripts/`;

class BroControl {

  constructor() {
    this.options = {};
    this.restarting = false;
  }

  optionsChanged(options) {
    return !_.isEqual(options, this.options);
  }

  async writeNetworksConfig(networks) {
    const networksCfg = [];
    for (const key of Object.keys(networks)) {
      networksCfg.push(`${key}\t${networks[key].join(',')}`);
    }
    if (networksCfg.length > 0) {
      await exec(`echo "${networksCfg.join('\n')}" | sudo tee ${PATH_LOCAL_NETWORK_CFG}`);
    }
  }

  async writeClusterConfig(options) {
    log.info('writeClusterConfig', options)
    // rewrite cluster node.cfg
    await exec(`sudo cp -f ${f.getFirewallaHome()}/etc/node.cluster.cfg ${PATH_NODE_CFG}`)

    const listenInterfaces = options.listenInterfaces || {};
    let workerCfg = []
    let index = 1
    for (const intf in listenInterfaces) {
      if (intf.endsWith(":0")) // do not listen on interface alias
        continue;
      const workerScript = []
      const workerScriptPath = `${PATH_WORKER_SCRIPTS}${intf}.${BRO_PROC_NAME}`
      const pcapBufsize = listenInterfaces[intf].pcapBufsize
      if (pcapBufsize) {
        workerScript.push(`redef Pcap::bufsize = ${pcapBufsize};\n`)
      }
      workerCfg.push(
        `\n`,
        `[worker-${index++}]\n`,
        `type=worker\n`,
        `host=localhost\n`,
        `interface=${intf}\n`,
      )
      if (workerScript.length) {
        workerCfg.push(`aux_scripts=${workerScriptPath}\n`)
        await exec(`echo "${workerScript.join('')}" | sudo tee ${workerScriptPath}`)
      }
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
    if (this.restarting) {
      // restart should be invoked at least once later if it is currently being invoked in case config is changed in the progress of current invocation
      if (!this.pendingRestart) {
        this.pendingRestart = true;
        while (this.restarting) {
          await delay(5000);
        }
        this.pendingRestart = false;
      } else {
        return;
      }
    }

    try {
      this.restarting = true
      log.info('Restarting brofish..')
      await exec(`sudo systemctl restart brofish`)
      this.restarting = false
      log.info('Restart complete')
    } catch (err) {
      log.error('Failed to restart brofish, will try again', err.toString())
      this.restarting = false;
      await delay(5000)
      return this.restart()
    }
  }

}

module.exports = new BroControl()
