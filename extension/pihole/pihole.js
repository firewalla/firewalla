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

const _ = require('lodash');

const exec = require('child-process-promise').exec;

const { delay } = require('../../util/util.js');

const f = require('../../net2/Firewalla.js');
const yaml = require('../../api/dist/lib/js-yaml.min.js');

const fs = require('fs');

const Promise = require('bluebird');
Promise.promisifyAll(fs);

const dockerPath = `${f.getRuntimeInfoFolder()}/docker`;
const piholeDockerPath = `${dockerPath}/pihole`;
const runtimeConfigFile = `${piholeDockerPath}/docker-compose.yml`;

const templateConfigFile = `${__dirname}/docker-compose.yml`;

const sysManager = require('../../net2/SysManager.js');

const tcpPort = 10053;
const udpPort = 10053;

class PiHole {
  constructor() {
    if(instance === null) {
      instance = this;
      this.config = {};
      this.ready = false;
    }
    return instance;
  }

//   version: "3"

// services:
//   pihole:
//     container_name: pihole
//     image: docker.io/firewalla/pihole:latest
//     ports:
//       - "%FW_PIHOLE_TCP_PORT%:53/tcp"
//       - "%FW_PIHOLE_UDP_PORT%:53/udp"
//     environment:
//       TZ: '%FW_TIMEZONE%'
//     volumes:
//        - './etc-pihole/:/etc/pihole/'
//        - './etc-dnsmasq.d/:/etc/dnsmasq.d/'
//     dns:
//       - 1.1.1.1
//     restart: unless-stopped

  async updateConfig(config, input = {}) {
    config.ports = [
      `'${tcpPort}:53/tcp'`,
      `'${udpPort}:53/udp'`
    ];
    const tz = await sysManager.getTimezone();
    config.environment["TZ"] = tz;    
  }  

  async preStart() {
    log.info("Preparing environment for pihole...");
    this.ready = false;
    try {
      await fs.mkdirAsync(piholeDockerPath, {recursive: true});
      const template = await fs.readFileAsync(templateConfigFile);
      if (template) {
        const doc = yaml.safeLoad(template);
        if(doc && doc.services) {

          if(doc.services.pihole) {
            this.updateConfig(doc.services.pihole, this.config);
          }       
        }
        
        const output = yaml.safeDump(doc);
        await fs.writeFileAsync(runtimeConfigFile, output);
      }      

      this.ready = true;
    } catch (err) {
      log.error("Got error when reading preparing config, err:", err);
      return;
    }
  }

  async start() {
    log.info("Starting pihole..");
    try {
      await this.preStart();
      await this.rawStart()
      
      let up = false;
      for(let i = 0; i < 30; i++) {
        log.info("Checking if pihole services are listening...");
        const listening = await this.isListening();
        if(listening) {
          log.info("Services are up.");
          up = true;
          break;
        }
        await delay(5000);
      }

      if(!up) {
        log.info("Failed to bring up pihole, quitting...");
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
    log.info("Starting pihole docker service...");

    if(!this.ready) {
      log.error("Config file is not ready yet");
    }

    return exec("sudo systemctl restart docker-compose@pihole")
  }

  async rawStop() {
    return exec("sudo systemctl stop docker-compose@pihole")
  }

  async postStart(config = {}) {
    // need to make sure both overture and trojan are listening..

  }

  async isListening() {
    try {
      await exec(`nc -w 5 -z localhost ${tcpPort} && netstat -an  | egrep -q ':::${udpPort}'`);
      return true;
    } catch(err) {
      return false;
    }
  }

  getName() {
    return (this.config && this.config.name) || "default";
  }

  // this needs to be done before rerouting traffic to docker
  async allowDockerBridgeToAccessWan() {
    const dockerNetworkConfig = await exec("sudo docker network inspect pihole_default");
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

  getUDPPort() {
    return udpPort;
  }
}

module.exports = new PiHole();
