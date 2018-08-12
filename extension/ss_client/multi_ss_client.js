/*    Copyright 2016 Firewalla LLC
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

const log = require("../../net2/logger.js")(__filename);
const rclient = require('../../util/redis_manager.js').getRedisClient();
const ssConfigKey = "scisurf.config";

const SysManager = require('../../net2/SysManager');
const sysManager = new SysManager();
const exec = require('child-process-promise').exec

const fs = require('fs');
const Promise = require('bluebird')
Promise.promisifyAll(fs);


const chnrouteFile = __dirname + "/chnroute";
const chnrouteRestoreForIpset = __dirname + "/chnroute.ipset.save";
const defaultDNS = "114.114.114.114";

const SSClient = require('./ss_client.js');

let instance = null;

class MultiSSClient {
  constructor() {
    if(instance == null) {
      instance = this;
      this.managedSS = [];
    }
    return instance;
  }

  // config may contain one or more ss server configurations
  async saveConfig(config) {
    const configCopy = JSON.parse(JSON.stringify(config));
    configCopy.version = "v2";
    await rclient.setAsync(ssConfigKey, JSON.stringify(configCopy));
    this.config = config;
  }

  async loadConfig() {
    const configString = await rclient.getAsync(ssConfigKey);
    try {
      JSON.parse(configString);
      this.config = config;
      return config;
    } catch(err) {
      log.error("Failed to parse mss config:", err);
      return null;
    }
  }
  
  async readyToStart() {
    const config = await this.loadConfig();
    if(config) {
      return true;
    } else {
      return false;
    }
  }
  
  async clearConfig() {
    return rclient.delAsync(ssConfigKey);
  }

  async loadConfigFromMem() {
    return this.config;
  }
  
  async _getSSConfigs() {
    const config = await this.loadConfig();
    if(config.servers) {
      return config.servers;
    }
    
    return [config];
  }

  async getPrimarySS() {
    return this.managedSS[0]; // FIXME
  }
  
  async switch() {
    // TODO
  }
  
  isGFWEnabled() {
    return true;
  }
  
  async start() {
    const sss = await this._getSSConfigs();
    this.isGFWEnabled() && await this._enableCHNIpset();
    this.isGFWEnabled() && await this._prepareCHNRouteFile();
    for (let i = 0; i < sss.length; i++) {
      const ss = sss[i];
      const s = new SSClient("" + i, ss, {});
      await s.start();
      this.managedSS.push(s);
    }
    
    const selectedSS = this.selectedSS();

    if(selectedSS) {
      await selectedSS.goOnline();
    }
  }
  
  selectedSS() {
    return this.managedSS[0];
  }

  async stop() {
    await this._disableCHNIpset();
    await this._revertCHNRouteFile();

    const selectedSS = this.selectedSS();

    if(selectedSS) {
      await selectedSS.goOffline();
    }

    for (let i = 0; i < this.managedSS.length; i++) {
      const s = this.managedSS[i];
      await s.stop();
    }
    
    this.managedSS = [];
  }
  
  async _enableCHNIpset() {
    const cmd = `sudo ipset -! restore -file ${chnrouteRestoreForIpset}`;
    log.info("Running cmd:", cmd);
    return exec(cmd);
  }
  
  async _disableCHNIpset() {
    const cmd = "sudo ipset destroy chnroute";
    log.info("Running cmd:", cmd);
    return exec(cmd).catch((err) => {
      log.error("Failed to destroy chnroute:", err);
    });
  }
  
  async _prepareCHNRouteFile() {
    let localDNSServers = sysManager.myDNS();
    if (localDNSServers == null || localDNSServers.length == 0) {
      // only use 114 dns server if local dns server is not available (NOT LIKELY)
      localDNSServers = [defaultDNS];

      const localDNS = localDNSServers[0];

      try {
        await fs.appendFileAsync(chnrouteFile, localDNS);
      } catch (err) {
        log.error("Failed to append local dns info to chnroute file, err:", err);
        return;
      }
    }
  }
  
  async _revertCHNRouteFile() {
    const revertCommand = `git checkout HEAD -- ${chnrouteFile}`;
    await exec(revertCommand).catch((err) => {});
  }
  
}

module.exports = new MultiSSClient();
