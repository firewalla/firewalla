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

const { exec } = require('child-process-promise');
const Promise = require('bluebird');
const fs = require('fs');
Promise.promisifyAll(fs);
const _ = require('lodash');
const YAML = require('../vendor_lib/yaml');
const delay = require('../util/util.js').delay;
const CUSTOMIZED_RULES_DIR = `${f.getRuntimeInfoFolder()}/suricata_rules`;

class SuricataControl {
  constructor() {
    this.restarting = false;
    this.rulesDirWatched = false;
  }

  watchRulesDir(callback) {
    if (this.rulesDirWatched)
      return;
    this.rulesDirWatched = true;
    fs.watch(CUSTOMIZED_RULES_DIR, (eventType, filename) => {
      if (callback)
        callback(eventType, filename);
    })
  }

  async reloadSuricataRules() {
    await exec(`sudo systemctl reload suricata`).catch((err) => {});
  }

  async addCronJobs() {
    await exec(`sudo cp ${f.getFirewallaHome()}/etc/logrotate.d/suricata.logrotate /etc/logrotate.d/suricata`).catch((err) => {
      log.error(`Failed to copy suricata logrotate config file to /etc/logrotate.d`, err.message);
    });
    log.info("Adding suricata related cron jobs");
    await fs.unlinkAsync(`${f.getUserConfigFolder()}/suricata_crontab`).catch((err) => {});
    await fs.symlinkAsync(`${f.getFirewallaHome()}/etc/suricata/crontab`, `${f.getUserConfigFolder()}/suricata_crontab`).catch((err) => {});
    await exec(`${f.getFirewallaHome()}/scripts/update_crontab.sh`).catch((err) => {
      log.error(`Failed to invoke update_crontab.sh`, err.message);
    })
  }

  async removeCronJobs() {
    await exec(`sudo rm -f /etc/logrotate.d/suricata`).catch((err) => {
      log.error(`Failed to remove suricata logrotate config file from /etc/logrotate.d`, err.message);
    });
    log.info("Removing suricata related cron jobs");
    await fs.unlinkAsync(`${f.getUserConfigFolder()}/suricata_crontab`).catch((err) => {});
    await exec(`${f.getFirewallaHome()}/scripts/update_crontab.sh`).catch((err) => {
      log.error(`Failed to invoke update_crontab.sh in removeCronJobs`, err.message);
    });
  }

  async cleanupRuntimeConfig() {
    await exec(`mkdir -p ${f.getRuntimeInfoFolder()}/suricata`).then(() => exec(`rm -rf ${f.getRuntimeInfoFolder()}/suricata/*`)).catch((err) => {
      log.error(`Failed to cleanup suricata runtime config directory`, err.message);
    });
  }

  async writeSuricataYAML(config) {
    await fs.writeFileAsync(`${f.getRuntimeInfoFolder()}/suricata/suricata.yaml`, "%YAML 1.1\n---\n" + YAML.stringify(config), {encoding: "utf8"}).catch((err) => {
      log.error(`Failed to write suricata.yaml to ${f.getRuntimeInfoFolder()}/suricata/suricata.yaml`, err.message);
    });
  }

    async prepareAssets() {
    await exec(`mkdir -p ${CUSTOMIZED_RULES_DIR}`).catch((err) => {});
    // copy other .config files to runtime folder
    await exec(`cp -r ${f.getFirewallaHome()}/etc/suricata/*.config ${f.getRuntimeInfoFolder()}/suricata`).catch((err) => {
      log.error(`Failed to copy .config files`, err.message);
    });
  }

  async getCustomizedRuleFiles() {
    const ruleFiles = await fs.readdirAsync(CUSTOMIZED_RULES_DIR).catch((err) => []);
    return ruleFiles;
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
      log.info('Restarting suricate ...')
      await exec(`sudo systemctl restart suricata`)
      this.restarting = false
      log.info('Restart suricata complete')
    } catch (err) {
      log.error('Failed to restart suricata, will try again', err.message)
      this.restarting = false;
      await delay(5000)
      return this.restart()
    }
  }

  async stop() {
    await exec(`sudo systemctl stop suricata`).catch((err) => {
      log.error(`Failed to stop suricata`, err.message);
    });
  }
}

module.exports = new SuricataControl();