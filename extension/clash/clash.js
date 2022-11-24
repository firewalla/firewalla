/*    Copyright 2020 Firewalla Inc.
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

const wrapIptables = require('../../net2/Iptables.js').wrapIptables;

const _ = require('lodash');

const exec = require('child-process-promise').exec;

const { delay } = require('../../util/util.js');

const f = require('../../net2/Firewalla.js');
const yaml = require('../../api/dist/lib/js-yaml.min.js');

const CountryUpdater = require('../../control/CountryUpdater.js');
const countryUpdater = new CountryUpdater();
const ipset = require('../../net2/Ipset.js');

const fs = require('fs');

const Promise = require('bluebird');
Promise.promisifyAll(fs);

class Clash {
  constructor() {
    if(instance === null) {
      instance = this;
      this.config = {};
      this.ready = false;
      this.shouldRedirect = false;
    }
    return instance;
  }

	// load config from redis sys:features:config
	// and generate yml files
  async prepareClashConfig() {
    const config = this.config || {};
		
		const dockerPath = `${f.getRuntimeInfoFolder()}/docker`;
		const clashDockerPath = `${dockerPath}/clash`;
		await fs.mkdirAsync(clashDockerPath, { recursive: true });
		const destConfigFilePath = `${clashDockerPath}/config.yml`

		log.info("Preparing config file for Clash:", destConfigFilePath);

		const templateFile = `${__dirname}/clash.template.yml`;
		const templateContent = await fs.readFileAsync(templateFile);
    const doc = yaml.safeLoad(templateContent);
    
    const serversConfig = config.servers || []  

    doc.proxies = serversConfig;

    const serverNames = serversConfig.map((config) => config.name);
    const pgs = doc["proxy-groups"];

    for(const pg of pgs) {
      if(pg.name === "auto") {
        pg.proxies = serverNames;
      }
    }

    const dnsServers = config.dns || ["1.1.1.1"];
    doc.dns.nameserver = dnsServers;

    const output = yaml.safeDump(doc);
    await fs.writeFileAsync(destConfigFilePath, output);
  }

  async prepareDockerComposeFile() {
    const dockerPath = `${f.getRuntimeInfoFolder()}/docker`;
		const clashDockerPath = `${dockerPath}/clash`;
    return exec(`cp ${__dirname}/docker-compose.yml ${clashDockerPath}/`);
  }

  getServers() {
    const serversConfig = this.config.servers || []  
    return serversConfig.map((config) => config.server);
  }

  async preStart() {
    log.info("Preparing environment for Clash...");
    this.ready = false;
    try {
      await this.prepareClashConfig();
      await this.prepareDockerComposeFile();

      await exec(`touch ${f.getUserHome()}/.forever/clash.log`);

      // setup iptables
      await exec(`${__dirname}/setup_iptables.sh`);

      const servers = this.getServers();

      for(const server of servers) {
        await exec(`sudo ipset add -! fw_clash_whitelist ${server}`);
      }

      // add exclude lists
      if(_.isArray(this.config.excludes)) {
        for(const exclude of this.config.excludes) {
          await exec(`sudo ipset add -! fw_clash_whitelist ${exclude}`);
        }
      }

      this.ready = true;
    } catch (err) {
      log.error("Got error when reading preparing config, err:", err);
      return;
    }
  }

  async start() {
    log.info("Starting Clash...");
    try {
      await this.preStart();
      await this.rawStart()
      
      let up = false;
      for(let i = 0; i < 30; i++) {
        log.info("Checking if clash services are listening...");
        const listening = await this.isListening();
        if(listening) {
          log.info("Services are up.");
          up = true;
          break;
        }
        await delay(5000);
      }

      if(!up) {
        log.info("Failed to bring up clash, quitting...");
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
    log.info("Starting Clash docker service...");

    if(!this.ready) {
      log.error("Config file is not ready yet");
    }

    return exec("sudo systemctl restart docker-compose@clash")
  }

  async rawStop() {
    return exec("sudo systemctl stop docker-compose@clash").catch(() => {})
  }

  async postStart(config = {}) {
    // need to make sure both overture and trojan are listening..

  }

  async isListening() {
    try {
      await exec("netstat -an  | egrep -q ':::9953'");
      return true;
    } catch(err) {
      return false;
    }
  }

  // prepare the chnroute files
  async prepareCHNRoute() {
    log.info("Preparing CHNRoute...");

    // intended non-blocking execution
    (async() => {
      const code = "CN";
      await countryUpdater.activateCountry(code);
      await exec(wrapIptables(`sudo iptables -w -t nat -I FW_CLASH_CHAIN -p tcp -m set --match-set c_bd_country:CN_set dst -j RETURN`));
    })()
  }

  async redirectTraffic() {
    await this.prepareCHNRoute();
    await exec(wrapIptables(`sudo iptables -w -t nat -A FW_PREROUTING -m set --match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} src,src -p tcp -j FW_CLASH_CHAIN`));
    this.shouldRedirect = true;    
  }

  async unRedirectTraffic() {
    await exec(wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING -m set --match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} src,src -p tcp -j FW_CLASH_CHAIN`));
    this.shouldRedirect = false;
  }

}

module.exports = new Clash();
