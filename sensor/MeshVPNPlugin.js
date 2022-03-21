/*    Copyright 2016 - 2022 Firewalla Inc
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

const extensionManager = require('./ExtensionManager.js')
const f = require('../net2/Firewalla.js');
const VPNClient = require('../extension/vpnclient/VPNClient.js');
const _ = require('lodash');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const MESH_PROFILE_ID = "FW_MESH";
const pclient = require('../util/redis_manager.js').getPublishClient();
const Message = require('../net2/Message.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();


const featureName = "mesh_vpn";

class MeshVPNPlugin extends Sensor {
  async run() {
    this.featureSwitch = false;
    this.localConfig = {};
    this.remoteConfig = {};
    this.hookFeature(featureName);

    if (f.isMain()) {
      sem.on("MESH_LOCAL_CONFIG_UPDATE", (event) => {
        const oldConfig = event.oldConfig;
        this.applyMeshVPN(oldConfig).catch((err) => {
          log.error(`Failed to apply mesh VPN`, err.message);
        });
      });
    }
  }

  async apiRun() {
    this.localConfig = {};
    this.remoteConfig = {};
    extensionManager.onCmd("mesh:fetchRemoteConfig", async (msg, data) => {
      await this.loadLocalConfig();
      if (this.localConfig.id && this.localConfig.instanceURL) {
        const configId = this.localConfig.id;
        const newConfig = await this.fetchRemoteConfig(this.localConfig.instanceURL, configId).catch((err) => {
          log.error(`Failed to fetch remote config of ${configId}`);
          return null;
        });
        if (!newConfig)
          return;
        await this.loadRemoteConfig(configId);
        const oldConfig = this.remoteConfig[configId];
        this.remoteConfig[configId] = newConfig;
        await this.saveRemoteConfig(configId);
        if (!_.isEqual(oldConfig, newConfig)) {
          log.info(`Mesh VPN remote config of ${configId} is changed, will generate new settings ...`);
          await this.generateVPNSettings();
          if (_.isEqual(oldConfig.cert, newConfig.cert)) // only need to update routes if cert is not changed
            await pclient.publishAsync(Message.MSG_NEBULA_VPN_ROUTE_UPDATE, MESH_PROFILE_ID);
          else // need to restart if cert is changed
            sem.sendEventToFireMain({
              type: "MESH_LOCAL_CONFIG_UPDATE",
              oldConfig: this.localConfig
            })
        }
      } else {
        log.error(`id is not defined in local config`)
      }
    });

    extensionManager.onCmd("mesh:updateLocalConfig", async (msg, data) => {
      const newConfig = {
        state: data.state || false,
        type: data.type || "nebula",
        id: data.id,
        instanceURL: data.instanceURL,
        auth: data.auth
      };
      await this.loadLocalConfig();
      const oldConfig = this.localConfig;
      this.localConfig = newConfig;
      await this.saveLocalConfig();
      if (!_.isEqual(oldConfig, newConfig)) {
        // firemain will maintain the VPN connection
        sem.sendEventToFireMain({
          type: "MESH_LOCAL_CONFIG_UPDATE",
          oldConfig: oldConfig
        });
      }
    });
  }

  async job() {
    await this.applyMeshVPN().catch((err) => {
      log.error(`Failed to apply mesh VPN`, err.message);
    });
  }

  async applyMeshVPN(oldLocalConfig = null) {
    if (oldLocalConfig) {
      // stop old vpn client according to old config if present
      if (oldLocalConfig.state) {
        const vpnType = oldLocalConfig.type;
        const c = VPNClient.getClass(vpnType);
        if (!c) {
          log.error(`Mesh VPN type ${vpnType} is not supported in old config`);
        } else {
          log.info(`Stop old ${vpnType} mesh VPN`);
          const vpnClient = new c({profileId: MESH_PROFILE_ID});
          await vpnClient.stop().catch((err) => {
            log.error(`Failed to stop ${vpnType} mesh VPN in old config`, err.message);
          });
        }
      }
    }
    await this.loadLocalConfig();
    const instanceURL = this.localConfig && this.localConfig.instanceURL;
    const id = this.localConfig && this.localConfig.id;
    if (!instanceURL || !id)
      return;
    const remoteConfig = await this.fetchRemoteConfig(instanceURL, id);
    this.remoteConfig[id] = remoteConfig;
    await this.saveRemoteConfig(id);
    await this.generateVPNSettings();
    const vpnType = this.localConfig && this.localConfig.type;
    if (!vpnType)
      return;
    const c = VPNClient.getClass(vpnType);
    if (!c) {
      log.error(`Mesh VPN type ${vpnType} is not supported`);
      return;
    }
    const vpnClient = new c({profileId: MESH_PROFILE_ID});
    if (this.featureSwitch && this.localConfig.state) {
      log.info(`Start ${vpnType} mesh VPN`);
      await vpnClient.setup().then(() => {
        return vpnClient.start();
      }).catch((err) => {
        log.error(`Failed to start ${vpnType} mesh VPN`, err.message);
      });
    } else {
      log.info(`Stop ${vpnType} mesh VPN`);
      await vpnClient.setup().then(() => {
        return vpnClient.stop();
      }).catch((err) => {
        log.error(`Failed to stop ${vpnType} mesh VPN`, err.message);
      });
    }
  }

  async generateVPNSettings() {
    const id = this.localConfig && this.localConfig.id;
    if (!id)
      return;
    const vpnType = this.localConfig && this.localConfig.type;
    const remoteConfig = this.remoteConfig[id];
    if (!vpnType || !id || !remoteConfig)
      return;
    const fullConfig = {
      localConfig: this.localConfig,
      remoteConfig: remoteConfig
    };
    const lighthouseIp = fullConfig.remoteConfig.lighthouse && fullConfig.remoteConfig.lighthouse.ip;
    const lighthouseEndpoint = fullConfig.remoteConfig.lighthouse && fullConfig.remoteConfig.lighthouse.endpoint;
    if (!lighthouseIp || !lighthouseEndpoint)
      return;
    const c = VPNClient.getClass(vpnType);
    if (!c) {
      log.error(`Mesh VPN type ${vpnType} is not supported`);
      return;
    }
    const vpnClient = new c({profileId: MESH_PROFILE_ID});
    const staticHostMap = {};
    staticHostMap[lighthouseIp] = [lighthouseEndpoint];
    const profileConfig = {
      config: {
        caCrt: fullConfig.localConfig.auth.ca,
        hostCrt: fullConfig.remoteConfig.cert,
        hostKey: fullConfig.localConfig.auth.private,
        extra: {
          static_host_map: staticHostMap,
          lighthouse: {
            hosts: [lighthouseIp]
          },
          tun: {
            unsafe_routes: fullConfig.remoteConfig.routes
          }
        }
      }
    };
    if (_.isArray(fullConfig.remoteConfig.dns) && !_.isEmpty(fullConfig.remoteConfig.dns))
      profileConfig.config.dns = fullConfig.remoteConfig.dns;
    const profileSettings = {
      overrideDefaultRoute: false,
      routeDNS: false,
      strictVPN: false,
      serverSubnets: []
    };
    await vpnClient.checkAndSaveProfile(profileConfig);
    await vpnClient.saveSettings(profileSettings);
    await vpnClient.setup();
  }

  async globalOn() {
    this.featureSwitch = true;
    await this.applyMeshVPN();
  }

  async globalOff() {
    this.featureSwitch = false;
    await this.applyMeshVPN();
  }

  async fetchRemoteConfig(instanceURL, cfgId) {
    if (f.isDevelopmentVersion()) {
      const testConfigPath = "/home/pi/remoteConfig.json";
      const testConfigExists = await fs.accessAsync(testConfigPath, fs.constants.R_OK).then(() => true).catch(() => false);
      if (testConfigExists) {
        return fs.readFileAsync("/home/pi/remoteConfig.json", {encoding: "utf8"}).then(content => JSON.parse(content)).catch((err) => null);
      }
    }
    const url = `${instanceURL}/v1/mesh/config/${cfgId}`;
    const Bone = require('../lib/Bone.js');
    const options = {
      uri: url,
      family: 4,
      method: "GET",
      auth: {
        bearer: Bone.getToken()
      },
      maxAttempts: 5,
      retryDelay: 1000
    };
    const rrWithErrHandling = require('../util/requestWrapper.js').rrWithErrHandling;
    const response = await rrWithErrHandling(options);
    return response.body;
  }

  _getRemoteConfigPath(configId) {
    return `${f.getRuntimeInfoFolder()}/mesh_vpn/mesh_remote_${configId}.conf`;
  }
 
  async saveRemoteConfig(configId) {
    if (this.remoteConfig.hasOwnProperty(configId)) {
      const config = this.remoteConfig[configId];
      await fs.writeFileAsync(this._getRemoteConfigPath(configId), JSON.stringify(config), {encoding: "utf8"});
    }
  }

  async loadRemoteConfig(configId) {
    const config = await fs.readFileAsync(this._getRemoteConfigPath(configId), {encoding: "utf8"}).then(content => JSON.parse(content)).catch((err) => {
      log.error(`Failed to read remote config of ${configId}`, err.message);
      return {};
    });
    this.remoteConfig[configId] = config;
    return config;
  }

  _getLocalConfigPath() {
    return `${f.getRuntimeInfoFolder()}/mesh_vpn/mesh_local.conf`;
  }

  async saveLocalConfig() {
    await fs.writeFileAsync(this._getLocalConfigPath(), JSON.stringify(this.localConfig), {encoding: "utf8"});
  }

  async loadLocalConfig() {
    const config = await fs.readFileAsync(this._getLocalConfigPath(), {encoding: "utf8"}).then(content => JSON.parse(content)).catch((err) => {
      log.error(`Failed to read local config`, err.message);
      return {};
    });
    this.localConfig = config;
    return config;
  }
}

module.exports = MeshVPNPlugin;