/*    Copyright 2016-2025 Firewalla Inc.
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
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const f = require('../net2/Firewalla.js');
const PlatformLoader = require('../platform/PlatformLoader.js');
const platform = PlatformLoader.getPlatform();
const fsp = require('fs').promises;
const { fileExist, fileRemove } = require('../util/util.js');
const Config = require('../net2/config.js');
const rp = util.promisify(require('request'));
const extensionManager = require('./ExtensionManager.js');

// internal properties
let dapInterface = null;

class DapSensor extends Sensor {
  constructor(config) {
    super(config);
    this.featureName = 'dap_bg_task';
  }

  async apiCall(method, path, body) {
    const options = {
      method: method,
      headers: {
        "Accept": "application/json"
      },
      timeout: 5000,
      url: dapInterface + path,
      json: true
    };

    if(body) {
      options.body = body;
    }
    try {
      const resp = await rp(options);
      let r =  {code: resp.statusCode, body: resp.body};
      if (resp.statusCode === 500) {
        r.msg = resp.body;
      }
      return r;
    } catch (e) {
      return {code: 500, msg: e.message};
    }
  }

  async getCheckInData() {
    log.debug('Getting checkin data');
    const result = await this.apiCall("GET", "/checkin");
    log.debug('Checkin data:', result);
    return result && result.body;
  }

  async apiRun() {
    // Initialize DAP interface configuration
    this.initDapRestClientFromConfig();

    // Register onCmd hook for "dap" item
    extensionManager.onCmd("dap", async (msg, data) => {
      if (!data.path) {
        throw new Error("invalid input");
      }

      if (!Config.isFeatureOn(this.featureName)) {
        throw new Error("DAP feature is not enabled");
      }

      const result = await this.apiCall(data.method || "GET", data.path, data.body);
      if (result.code == 200) {
        return result.body;
      } else {
        throw new Error(`DAP API call failed: ${result.msg || result.code}`);
      }
    });
  }

  initDapRestClientFromConfig() {
    const fwConfig = Config.getConfig();
    if (fwConfig.dap && fwConfig.dap.interface) {
      const intf = fwConfig.dap.interface;
      dapInterface = `http://${intf.host}:${intf.port}/${intf.version}`;
    } else {
      dapInterface = 'http://localhost:8843/v1';
    }
  }

  async run() {
    log.info('DapSensor is launched');
    this.initDapRestClientFromConfig();
    this.hookFeature(this.featureName);
  }

  async globalOn(featureName) {
    log.info(`Enabling DAP feature: ${featureName}`);
    try {
      // Copy the assets list to extra assets directory
      const extraAssetsDir = f.getExtraAssetsDir();
      await fsp.copyFile(`${platform.getPlatformFilesPath()}/02_assets_dap.lst`, `${extraAssetsDir}/02_assets_dap.lst`);
      
      // Update DAP binary from assets
      log.info('Checking DAP update from assets...');
      await execAsync(`ASSETSD_PATH=${extraAssetsDir} ${f.getFirewallaHome()}/scripts/update_assets.sh`).catch((err) => {
        log.error(`Failed to invoke update_assets.sh`, err.message);
      });
      
      // Start the fwdap.service
      log.info('Starting fwdap.service...');
      const { stdout, stderr } = await execAsync('sudo systemctl start fwdap.service');
      if (stderr) {
        log.warn('Warning when starting fwdap.service:', stderr);
      }
      log.info('fwdap.service started successfully');
      
    } catch (error) {
      log.error('Failed to enable DAP feature:', error.message);
      throw error;
    }
  }

  async globalOff(featureName) {
    log.info(`Disabling DAP feature: ${featureName}`);
    try {
      // Stop the fwdap.service
      log.info('Stopping fwdap.service...');
      const { stdout, stderr } = await execAsync('sudo systemctl stop fwdap.service');
      if (stderr) {
        log.warn('Warning when stopping fwdap.service:', stderr);
      }
      log.info('fwdap.service stopped successfully');
      
      // Remove the assets list file
      const assetsLstPath = `${f.getExtraAssetsDir()}/02_assets_dap.lst`;
      if (await fileExist(assetsLstPath)) {
        await fileRemove(assetsLstPath);
        log.info('Removed DAP assets list file');
      }
      
    } catch (error) {
      log.error('Failed to disable DAP feature:', error.message);
      throw error;
    }
  }

  async job() {
    // Periodic job that runs when the feature is enabled
    // This can be used for:
    // - Checking device security status
    // - Applying automatic security measures
    // - Logging security events
    log.debug('DapSensor job running');
  }
}

module.exports = DapSensor; 