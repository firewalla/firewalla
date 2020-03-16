/*    Copyright 2019-2020 Firewalla Inc.
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

const log = require('../../net2/logger.js')(__filename);

const sem = require('../../sensor/SensorEventManager.js').getInstance();

const rclient = require('../../util/redis_manager').getRedisClient();

const _ = require('lodash');

const exec = require('child-process-promise').exec;

const DNSMASQ = require('../dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const f = require('../../net2/Firewalla.js');
const yaml = require('../../api/dist/lib/js-yaml.min.js');

const configKey = "ext.ss2.config";

const fs = require('fs');

const Promise = require('bluebird');
Promise.promisifyAll(fs);

const dockerPath = `${f.getRuntimeInfoFolder()}/docker`;
const ss2DockerPath = `${dockerPath}/ss2`;
const runtimeConfigFile = `${ss2DockerPath}/docker-compose.yml`;

const templateConfigFile = `${__dirname}/docker-compose.yml`;


class SS2 {
  constructor() {
    if(instance === null) {
      instance = this;
      this.ready = false;
    }
    return instance;
  }

  updateOverture(config, sourceConfig) {
    let dns = sourceConfig.dns || "1.1.1.1";
    if(_.isArray(dns) && !_.isEmpty(dns)) {
      dns = dns[0];
    }

    config.environment = config.environment.map((env) => {
      if(env === 'LOCAL_DNS=1.1.1.1' && sourceConfig.dns) {
        return `LOCAL_DNS=${sourceConfig.dns}`;
      } else {
        return env;
      }
    });
  }

  updateProxy(config, sourceConfig) {
    config.environment = config.environment.map((env) => {
      if(env === 'TROJAN_SERVER=server' && sourceConfig.server) {
        return `TROJAN_SERVER=${sourceConfig.server}`;
      } else if(env === 'TROJAN_PASSWORD=password' && sourceConfig.password) {
        return `TROJAN_PASSWORD=${sourceConfig.password}`;
      } else {
        return env;
      }
    });
  }

  async preStart(config = {}) {
    this.ready = false;
    try {
      await fs.mkdirAsync(ss2DockerPath);
      const config = this.getConfig();
      log.info(config);
      const template = await fs.readFileAsync(templateConfigFile);
      if (template) {
        const doc = yaml.safeLoad(template);
        if(doc && doc.services) {

          if(doc.services.overture) {
            this.updateOverture(doc.services.overture, config);
          }
          if(doc.services.trojan) {
            this.updateProxy(doc.services.trojan, config);
          }
          if(doc.services.trojan_socks) {
            this.updateProxy(doc.services.trojan_socks, config);
          }
        }
        
        const output = yaml.safeDump(doc);
        await fs.writeFileAsync(runtimeConfigFile, output);
      }      

      await exec(`FW_SS_SERVER=${config.server} FW_SS_REDIR_PORT=9954 NAME=${this.getChainName(config)} ${__dirname}/setup_iptables.sh`);

      this.ready = true;
    } catch (e) {
      log.error("Got error when reading preparing config, err:", err);
      return;
    }
  }

  async start(dnsConfig = {}) {
    try {
      const redisConfig = this.getConfig();
      if(!redisConfig) {
        return;
      }

      const totalConfig = Object.assign({}, redisConfig, dnsConfig);

      await this.preStart(totalConfig);
      await this.rawStart()
      await this.postStart(totalConfig);
    } catch (err) {
      log.info("Failed to parse config, err:", err);
    }

  }

  async stop() {
    return this.rawStop();
  }

  async rawStart() {
    if(!this.ready) {
      log.error("Config file is not ready yet");
    }

    return exec("sudo systemctl restart docker-compose@ss2")
  }

  async rawStop() {
    return exec("sudo systemctl stop docker-compose@ss2")
  }

  async postStart(config = {}) {
    // need to make sure both overture and trojan are listening..

  }

  async isListening() {

  }

  async getConfig() {
    const redisConfig = await rclient.getAsync(configKey);
    if (!redisConfig) {
      return null;
    }

    try {
      return JSON.parse(redisConfig);
    } catch(err) {
      log.error("Failed to load config from redis, err:", err);
      return null;
    }
  }

  async setConfig(config) {
    return rclient.setAsync(configKey, JSON.stringify(config));
  }

  getChainName(config = {}) {
    return `FW_SS_${config.name || "default"}`;
  }

  async redirectTraffic(config = {}) {
    await exec(wrapIptables(`sudo iptables -w -t nat -A FW_PREROUTING -p tcp -j ${this.getChainName(config)}`));
  }

  async unRedirectTraffic() {
    await exec(wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING -p tcp -j ${this.getChainName(config)}`));
  }

  getDNSPort() {
    return 9953;
  }

  getLocalServer() {
    return "127.0.0.1#9953"
  }
}

module.exports = new SS2();
