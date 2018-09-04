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

const haproxyPort = 7388;

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
      const config = JSON.parse(configString);
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

  async install() {
    const cmd = "bash -c 'sudo which ipset &>/dev/null || sudo apt-get install -y ipset'";
    await exec(cmd);
    const cmd2 = "bash -c 'sudo which haproxy &>/dev/null || sudo apt-get install -y haproxy'";
    await exec(cmd2);
    const cmd3 = "sudo systemctl stop haproxy";
    await exec(cmd3);
  }

  async prepareHAProxyConfigFile() {
    let templateData = await fs.readFileAsync(this.getHAProxyConfigTemplateFile(), 'utf8');
    templateData = templateData.replace(/HAPROXY_LOCAL_PORT/g, haproxyPort);

    const servers = await this._getSSConfigs();
    const proxy_content = servers.map((s) => {
      return `        server  ${s.server}    ${s.server}:${s.server_port}`;
    }).join("\n");

    templateData = templateData.replace(/HAPROXY_SERVERS/g, proxy_content);
    await fs.writeFileAsync(this.getHAProxyConfigFile(), templateData, 'utf8');
  }

  getHAProxyConfigFile() {
    return __dirname + "/haproxy.cfg";
  }

  getHAProxyConfigTemplateFile() {
    return __dirname + "/haproxy.cfg.template"
  }

  async _startHAProxy() {
    await this._stopHAProxy(); // stop before start
    await this.prepareHAProxyConfigFile();
    const cmd = `haproxy -D -f ${this.getHAProxyConfigFile()}`;
    return exec(cmd);
  }

  async _stopHAProxy() {
    const cmd = "pkill haproxy";
    return exec(cmd).catch((err) => {});
  }

  async getHASSConfig() {
    const ssConfigs = await this._getSSConfigs();
    if(ssConfigs.length > 0) {
      const config = ssConfigs[0];
      const configCopy = JSON.parse(JSON.stringify(config));
      configCopy.server = "127.0.0.1";
      configCopy.server_port = haproxyPort;
      return configCopy;
    } else {
      return null;
    }
  }

  async start() {
    try {
      await this.install();

      const sss = await this._getSSConfigs();
      this.isGFWEnabled() && await this._enableCHNIpset();
      this.isGFWEnabled() && await this._revertCHNRouteFile();
      this.isGFWEnabled() && await this._prepareCHNRouteFile();

      await this._startHAProxy();

      const config = await this.getHASSConfig();

      this.ssClient = new SSClient(config, {
        gfw: this.isGFWEnabled()
      });
      this.ssClient.ssServers = sss.map((s) => s.server);

      await this.ssClient.start();
      await this.ssClient.goOnline();
    } catch(err) {
      log.error("Failed to start mss, revert it back, err:", err);
      await this.stop().catch((err) => {});
    }
  }

  async stop() {
    if(this.ssClient) {
      await this.ssClient.goOffline();
      await this.ssClient.stop();
    }

    await this._stopHAProxy();
    await this._disableCHNIpset();
    await this._revertCHNRouteFile();
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
    }

    const localDNS = localDNSServers[0];

    try {
      await fs.appendFileAsync(chnrouteFile, localDNS);
    } catch (err) {
      log.error("Failed to append local dns info to chnroute file, err:", err);
    }
  }
  
  async _revertCHNRouteFile() {
    const revertCommand = `git checkout HEAD -- ${chnrouteFile}`;
    await exec(revertCommand).catch((err) => {});
  }
  
}

module.exports = new MultiSSClient();
