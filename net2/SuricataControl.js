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
const fs = require('fs');
const fsp = require('fs').promises;
const _ = require('lodash');
const YAML = require('../vendor_lib/yaml');
const delay = require('../util/util.js').delay;
const BASIC_RULRS_DIR = `${f.getRuntimeInfoFolder()}/suricata_basic_rules`;
const MSP_RULES_DIR = `${f.getRuntimeInfoFolder()}/suricata_msp_rules`;
const platform = require('../platform/PlatformLoader.js').getPlatform();

class SuricataControl {
  constructor() {
    this.restarting = false;
    this.rulesDirWatched = false;
  }

  watchRulesDir(callback) {
    if (this.rulesDirWatched)
      return;
    this.rulesDirWatched = true;
    fs.watch(BASIC_RULRS_DIR, (eventType, filename) => {
      if (callback)
        callback(eventType, filename);
    });
    fs.watch(MSP_RULES_DIR, (eventType, filename) => {
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
    await fsp.unlink(`${f.getUserConfigFolder()}/suricata_crontab`).catch((err) => {});
    await fsp.symlink(`${f.getFirewallaHome()}/etc/suricata/crontab`, `${f.getUserConfigFolder()}/suricata_crontab`).catch((err) => {});
    await exec(`${f.getFirewallaHome()}/scripts/update_crontab.sh`).catch((err) => {
      log.error(`Failed to invoke update_crontab.sh`, err.message);
    })
  }

  async removeCronJobs() {
    await exec(`sudo rm -f /etc/logrotate.d/suricata`).catch((err) => {
      log.error(`Failed to remove suricata logrotate config file from /etc/logrotate.d`, err.message);
    });
    log.info("Removing suricata related cron jobs");
    await fsp.unlink(`${f.getUserConfigFolder()}/suricata_crontab`).catch((err) => {});
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
    await fsp.writeFile(`${f.getRuntimeInfoFolder()}/suricata/suricata.yaml`, "%YAML 1.1\n---\n" + YAML.stringify(config), {encoding: "utf8"}).catch((err) => {
      log.error(`Failed to write suricata.yaml to ${f.getRuntimeInfoFolder()}/suricata/suricata.yaml`, err.message);
    });
  }

  async tryUpdateSuricataBinary() {
    try {
      // Check if the current platform supports suricata from assets
      
      const isSupported = await platform.isSuricataFromAssetsSupported();
      if (!isSupported) {
        log.info("Suricata from assets not supported on this platform");
        return;
      }

      // Create suricata binary lst file for assets
      const suricataBinaryPath = `${f.getRuntimeInfoFolder()}/assets/suricata`;
      const suricataBinaryTarPath = `${f.getRuntimeInfoFolder()}/assets/suricata.tar.gz`;
      const assetsConf = `${suricataBinaryTarPath} /gold/assets/u22/6.5.0-25-generic/suricata.tar.gz 644 ":" "tar xzf ${suricataBinaryTarPath} -C ${f.getRuntimeInfoFolder()}/assets; sudo ln -sfT ${suricataBinaryPath} /usr/bin/suricata; if systemctl is-active suricata; then sudo systemctl restart suricata; fi"`;
      const assetsConfPath = `${f.getExtraAssetsDir()}/assets_suricata.lst`;
      
      await fsp.writeFile(assetsConfPath, assetsConf, {encoding: "utf8"});
      log.info(`Created suricata binary assets config at ${assetsConfPath}`);
      
      // Update assets using the update_assets.sh script
      await exec(`ASSETSD_PATH=${f.getExtraAssetsDir()} ${f.getFirewallaHome()}/scripts/update_assets.sh`);
      await exec(`tar xzf ${suricataBinaryTarPath} -C ${f.getRuntimeInfoFolder()}/assets`);
      await exec(`sudo ln -sfT ${suricataBinaryPath} /usr/bin/suricata`);
      log.info("Updated suricata binary assets");
    } catch(err) {
      log.error("Failed to update suricata binary", err);
    }
  }

  async prepareAssets() {
    await fsp.mkdir(BASIC_RULRS_DIR, {recursive: true}).catch((err) => {});
    await fsp.mkdir(MSP_RULES_DIR, {recursive: true}).catch((err) => {});
    await fsp.mkdir(`${f.getRuntimeInfoFolder()}/suricata`, {recursive: true}).catch((err) => {});
    // copy other .config files to runtime folder
    await exec(`cp -r ${f.getFirewallaHome()}/etc/suricata/*.config ${f.getRuntimeInfoFolder()}/suricata`).catch((err) => {
      log.error(`Failed to copy .config files`, err.message);
    });
  }

  async addRulesFromAssets(id) {
    const assetsConf = `${BASIC_RULRS_DIR}/${id}.rules /all/suricata_rules/${id}.rules 644`;
    const assetsConfPath = `${f.getExtraAssetsDir()}/sc_rule_${id}.lst`;
    await fsp.writeFile(assetsConfPath, assetsConf, {encoding: "utf8"}).catch((err) => {
      log.error(`Failed to write ${assetsConfPath}`, err.message);
    });
    await exec(`ASSETSD_PATH=${f.getExtraAssetsDir()} ${f.getFirewallaHome()}/scripts/update_assets.sh`).catch((err) => {
      log.error(`Failed to invoke update_assets.sh`, err.message);
    });
  }

  async deleteRulesFromAssets(id) {
    const assetsConfPath = `${f.getExtraAssetsDir()}/sc_rule_${id}.lst`;
    await fsp.unlink(assetsConfPath).catch((err) => {});
    const ruleFilePath = `${BASIC_RULRS_DIR}/${id}.rules`;
    await fsp.unlink(ruleFilePath).catch((err) => {});
  }

  async getRuleFiles(source) {
    const ruleFiles = [];
    if (!source || source === "basic") {
      const basicRuleFiles = await fsp.readdir(BASIC_RULRS_DIR).catch((err) => []);
      ruleFiles.push(...basicRuleFiles.map(filename => `${BASIC_RULRS_DIR}/${filename}`));
    }
    if (!source || source === "msp") {
      const mspRuleFiles = await fsp.readdir(MSP_RULES_DIR).catch((err) => []);
      ruleFiles.push(...mspRuleFiles.map(filename => `${MSP_RULES_DIR}/${filename}`));
    }
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

  async saveRules(rules, filename, source = 'msp') {
    const rulesDir = source === 'basic' ? BASIC_RULRS_DIR : MSP_RULES_DIR;
    const path = `${rulesDir}/${filename}`;
    await fsp.writeFile(path, rules.join("\n"));
  }

  async deleteRules(filename, source = 'msp') {
    const rulesDir = source === 'basic' ? BASIC_RULRS_DIR : MSP_RULES_DIR;
    const path = `${rulesDir}/${filename}`;
    await fsp.unlink(path).catch((err) => {})
  }

  async cleanupRules(source = 'msp') {
    const ruleFiles = await this.getRuleFiles(source);
    for (const ruleFile of ruleFiles) {
      await fsp.unlink(ruleFile);
    }
  }
}

module.exports = new SuricataControl();