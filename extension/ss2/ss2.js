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

const wrapIptables = require('../../net2/Iptables.js').wrapIptables;

const _ = require('lodash');

const exec = require('child-process-promise').exec;

const DNSMASQ = require('../dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const { delay } = require('../../util/util.js');

const f = require('../../net2/Firewalla.js');
const yaml = require('../../api/dist/lib/js-yaml.min.js');

const CountryUpdater = require('../../control/CountryUpdater.js');
const countryUpdater = new CountryUpdater();
const ipset = require('../../net2/Ipset.js');

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
      this.config = {};
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
      if(env === 'LOCAL_DNS=1.1.1.1' && dns) {
        return `LOCAL_DNS=${dns}`;
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
    log.info("Preparing environment for SS2...");
    this.ready = false;
    try {
      await fs.mkdirAsync(ss2DockerPath, {recursive: true});
      const template = await fs.readFileAsync(templateConfigFile);
      if (template) {
        const doc = yaml.safeLoad(template);
        if(doc && doc.services) {

          if(doc.services.overture) {
            this.updateOverture(doc.services.overture, this.config);
          }
          if(doc.services.trojan) {
            this.updateProxy(doc.services.trojan, this.config);
          }
          if(doc.services.trojan_socks) {
            this.updateProxy(doc.services.trojan_socks, this.config);
          }

        }
        
        const output = yaml.safeDump(doc);
        await fs.writeFileAsync(runtimeConfigFile, output);
      }      

      await exec(`FW_SS_SERVER=${this.config.server} FW_SS_REDIR_PORT=9954 NAME=${this.getChainName()} ${__dirname}/setup_iptables.sh`);

      this.ready = true;
    } catch (err) {
      log.error("Got error when reading preparing config, err:", err);
      return;
    }
  }

  async start() {
    log.info("Starting SS2..");
    try {
      await this.preStart();
      await this.rawStart()
      
      let up = false;
      for(let i = 0; i < 30; i++) {
        log.info("Checking if ss2 services are listening...");
        const listening = await this.isListening();
        if(listening) {
          log.info("Services are up.");
          up = true;
          break;
        }
        await delay(5000);
      }

      if(!up) {
        log.info("Failed to bring up ss2, quitting...");
        return;
      }

      await this.postStart();
    } catch (err) {
      log.info("Failed to parse config, err:", err);
    }

  }

  async stop() {
    return this.rawStop();
  }

  async rawStart() {
    log.info("Starting SS2 docker service...");

    if(!this.ready) {
      log.error("Config file is not ready yet");
    }

    return exec("sudo systemctl restart docker-compose@ss2")
  }

  async rawStop() {
    return exec("sudo systemctl stop docker-compose@ss2").catch(() => {})
  }

  async postStart(config = {}) {
    // need to make sure both overture and trojan are listening..

  }

  async isListening() {
    try {
      await exec("nc -w 5 -z localhost 9954 && nc -w 5 -z localhost 9955 && netstat -an  | egrep -q ':::9953'");
      return true;
    } catch(err) {
      return false;
    }
  }

  getName() {
    return (this.config && this.config.name) || "default";
  }

  getChainName() {
    return `FW_SS2_${this.getName()}`;
  }

  // this needs to be done before rerouting traffic to docker
  async allowDockerBridgeToAccessWan() {
    const dockerNetworkConfig = await exec("sudo docker network inspect ss2_default");
    const stdout = dockerNetworkConfig.stdout;
    if(!stdout) {
      throw new Error("invalid docker network inspect output");
    }

    try {
      const config = JSON.parse(stdout);
      if(!_.isEmpty(config)) {
        const network1 = config[0];
        const bridgeName = `br-${network1.Id && network1.Id.substring(0, 12)}`;
        const subnet = network1.IPAM && network1.IPAM.Config && network1.IPAM.Config[0] && network1.IPAM.Config[0].Subnet;
        if(bridgeName && subnet) {
          await exec(`sudo ip route add ${subnet} dev ${bridgeName} table wan_routable`);
        } else {
          throw new Error("invalid docker network");
        }
      }
    } catch(err) {
      log.error("Failed to setup docker bridge access, err:", err);
    }
  }

  // prepare the chnroute files
  async prepareCHNRoute() {
    log.info("Preparing CHNRoute...");

    // intended non-blocking execution
    (async() => {
      const code = "CN";
      await countryUpdater.activateCountry(code);
      await exec(wrapIptables(`sudo iptables -w -t nat -I ${this.getChainName()} -p tcp -m set --match-set c_bd_country:CN_set dst -j RETURN`));
    })()
  }

  async redirectTraffic() {
    await this.allowDockerBridgeToAccessWan();
    await this.prepareCHNRoute();
    await exec(wrapIptables(`sudo iptables -w -t nat -A FW_PREROUTING -m set --match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} src,src -p tcp -j ${this.getChainName()}`));
    
  }

  async unRedirectTraffic() {
    await exec(wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING -m set --match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} src,src -p tcp -j ${this.getChainName()}`));
  }

  getDNSPort() {
    return 9953;
  }

  getLocalServer() {
    return "127.0.0.1#9953"
  }
}

module.exports = new SS2();
