/*    Copyright 2022-2023 Firewalla Inc.
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

let instance = null;

const log = require('../../net2/logger')(__filename);

const fs = require('fs');
const fsp = require('fs').promises
const util = require('util');
const existsAsync = util.promisify(fs.exists);
const firewalla = require('../../net2/Firewalla.js');
const { fileRemove } = require('../../util/util.js')

const rclient = require('../../util/redis_manager').getRedisClient();

const exec = require('child-process-promise').exec;

const configKey = "ext.unbound";

const templateConfPath = `${firewalla.getFirewallaHome()}/extension/unbound/unbound.template.conf`;
const runtimeConfPath = `${firewalla.getRuntimeInfoFolder()}/unbound/unbound.conf`;

const mustache = require("mustache");
const VPNClient = require('../vpnclient/VPNClient');
const UNBOUND_FWMARK_KEY = "unbound:markkey";

class Unbound {
  constructor() {
    if (instance === null) {
      instance = this;
      this.config = {};
      this._restartTask = null;
    }

    return instance;
  }

  getLocalPort() {
    return this.config.localPort || 8953;
  }

  getLocalServer() {
    return `127.0.0.1#${this.config.localPort || 8953}`;
  }

  getDefaultConfig() {
    return {
      upstream: "udp",
      dnssec: true
    };
  }

  async getUserConfig() {
    const config = await rclient.hgetallAsync(configKey) || {};
    Object.keys(config).map((key) => {
      config[key] = JSON.parse(config[key]);
    });
    return config;
  }

  async getConfig() {
    return Object.assign({}, this.getDefaultConfig(), await this.getUserConfig());
  }

  async updateUserConfig(newConfig) {
    let multi = rclient.multi();
    multi.unlink(configKey);
    for (const key in newConfig) {
      multi.hset(configKey, key, JSON.stringify(newConfig[key]));
    }
    await multi.execAsync();
  }

  async prepareConfigFile(reCheckConfig = false) {
    const configFileTemplate = await fsp.readFile(templateConfPath, { encoding: 'utf8' });
    const unboundConfig = await this.getConfig();
    log.info("Use unbound config:", unboundConfig);

    // update fw markkey
    const vpnClientConfig = unboundConfig.vpnClient
    if (vpnClientConfig && vpnClientConfig.state && vpnClientConfig.profileId) {
      const markKey = VPNClient.getRouteMarkKey(vpnClientConfig.profileId);
      log.info("Set markkey to", markKey);
      await rclient.setAsync(UNBOUND_FWMARK_KEY, markKey);
    } else {
      log.info("Reset markkey");
      await fileRemove(UNBOUND_FWMARK_KEY);
    }

    // update unbound conf file
    const view = {
      useTcpUpstream: (unboundConfig.upstream === "tcp" ? true : false),
      useDnssec: unboundConfig.dnssec
    };
    const configFileContent = mustache.render(configFileTemplate, view);

    if (reCheckConfig) {
      const fileExists = await existsAsync(runtimeConfPath);
      if (fileExists) {
        const oldContent = await fsp.readFile(runtimeConfPath, { encoding: 'utf8' });
        if (oldContent === configFileContent)
          return false;
      }
    }

    await fsp.writeFile(runtimeConfPath, configFileContent);
    return true;
  }

  async start() {
    await exec("sudo systemctl start unbound");
    return;
  }

  restart() {
    if (this._restartTask) {
      clearTimeout(this._restartTask);
    }
    this._restartTask = setTimeout(() => {
      exec("sudo systemctl restart unbound").catch((err) => {
        log.error("Failed to restart unbound", err.message);
      });
    }, 3000);
  }

  async stop() {
    if (this._restartTask) {
      clearTimeout(this._restartTask);
    }
    await exec("sudo systemctl stop unbound");
    return;
  }

  async reset() {
    await this.stop()
    await rclient.unlinkAsync(configKey, UNBOUND_FWMARK_KEY)
    await fileRemove(runtimeConfPath)
  }
}

module.exports = new Unbound();
