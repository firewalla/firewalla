/*    Copyright 2016-2020 Firewalla Inc.
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

const log = require("../../net2/logger.js")(__filename, "info");
const rclient = require('../../util/redis_manager.js').getRedisClient();

const fs = require('fs');
const jsonfile = require('jsonfile');

const DNSMASQ = require('../dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec

const Promise = require('bluebird')

const jsonfileWrite = Promise.promisify(jsonfile.writeFile)
Promise.promisifyAll(fs);

const f = require('../../net2/Firewalla.js');

const sysManager = require('../../net2/SysManager');

const ssConfigKey = "scisurf.config";

const delay = require('../../util/util.js').delay;

const wrapIptables = require('../../net2/Iptables.js').wrapIptables;

const REMOTE_DNS = "8.8.8.8";
const REMOTE_DNS_PORT = 53;

const statusCheckInterval = 1 * 60 * 1000;

const _ = require('lodash');

const CountryUpdater = require('../../control/CountryUpdater.js')
const countryUpdater = new CountryUpdater()

class SSClient {
  constructor(config = {}) {
    if(!config) {
      throw new Error("Invalid name or config when new SSClient");
    }

    this.name = config.name || `${config.server}:${config.serverPort}`;
    this.config = config;
    this.started = false;
    this.statusCheckTimer = null;
    this.statusCheckResult = null;
    this.overturePort = config.overturePort || 8854;
    this.ssRedirectPort = config.ssRedirectPort || 8820;
    this.ssClientPort = config.ssClientPort || 8822;

    log.info(`Creating ss client ${this.name}...`);//, config: ${require('util').inspect(this.config, {depth: null})}, options, ${require('util').inspect(this.options, {depth: null})}`);
  }

  // This only starts the service, call redirectTraffic to redirect devices traffic
  async start() {
    log.info("Starting SS backend service...");
    await this._createConfigFile();
    await exec(`sudo systemctl restart ss_client@${this.name}`);
    log.info("Started SS backend service.");

    this.statusCheckTimer = setInterval(async () => {
      this.statusCheckJob();
    }, statusCheckInterval);
  }

  async statusCheckJob (retryCount = 0) {
    const result = await this.statusCheck();
    log.info(`[${retryCount}] Status check result for ${this.name}: online ${result.status}, latency ${result.time * 1000} ms`);
    if(result.status && result.status === true) {
      this.statusCheckResult = result;
    } else {
      if(retryCount > 5) {
        this.statusCheckResult = result;
      } else {
        return this.statusCheckJob(retryCount+1);
      }
    }
  }


  async stop() {
    if(this.statusCheckTimer) {
      clearInterval(this.statusCheckTimer);
      this.statusCheckTimer = null;
    }
    log.info(`Stopping SS backend service ${this.name}...`);
    await exec(`sudo systemctl stop ss_client@${this.name}`);
    log.info(`Stopped SS backend service ${this.name}.`);
  }


  async redirectTraffic() {
    // set dnsmasq upstream to overture
    const upstreamDNS = `127.0.0.1#${this.overturePort}`;
    await dnsmasq.setUpstreamDNS(upstreamDNS);

    // dns
//    const dnsChain = `FW_SHADOWSOCKS_DNS_${this.name}`;
    await exec(wrapIptables(`sudo iptables -w -t nat -A OUTPUT -p tcp --destination ${REMOTE_DNS} --destination-port ${REMOTE_DNS_PORT} -j REDIRECT --to-port ${this.ssRedirectPort}`));

    // reroute all devices's traffic to ss special chain
    const chain = `FW_SHADOWSOCKS_${this.name}`;
    await exec(wrapIptables(`sudo iptables -w -t nat -A FW_PREROUTING -p tcp -j ${chain}`));
  }

  async unRedirectTraffic() {
    // unreroute all traffic
    const chain = `FW_SHADOWSOCKS_${this.name}`;
    await exec(wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING -p tcp -j ${chain}`));

    // dns
    await exec(wrapIptables(`sudo iptables -w -t nat -D OUTPUT -p tcp --destination ${REMOTE_DNS} --destination-port ${REMOTE_DNS_PORT} -j REDIRECT --to-port ${this.ssRedirectPort}`));
    //const dnsChain = `FW_SHADOWSOCKS_DNS_${this.name}`;
    //await exec(wrapIptables(`sudo iptables -w -t nat -D OUTPUT -p tcp -j ${dnsChain}`));

    // set dnsmasq upstream back to default
    await dnsmasq.setUpstreamDNS(null);
  }

  async resetConfig() {
    // do nothing
  }

  // file paths
  getConfigPath() {
    return `${f.getRuntimeInfoFolder()}/ss_client.${this.name}.config.json`;
  }

  // START
  async _createConfigFile() {
    await jsonfileWrite(this.getConfigPath(), this.config);
    await this.prepareOvertureConfig();
    await this.prepareServiceConfig();
    await this.prepareCHNRoute();
  }

  async prepareOvertureConfig() {
    const localDNSServers = sysManager.myDNS();
    if(_.isEmpty(localDNSServers)) {
      throw new Error("missing local dns server");
    }

    const templatePath = `${__dirname}/overture.config.template.json`;
    let content = await fs.readFileAsync(templatePath, {encoding: 'utf8'});
    content = content.replace("%FIREWALLA_OVERTURE_PORT%", this.overturePort);
    content = content.replace("%FIREWALLA_PRIMARY_DNS%", localDNSServers[0]);
    content = content.replace("%FIREWALLA_PRIMARY_DNS_PORT%", 53);
    content = content.replace("%FIREWALLA_ALTERNATIVE_DNS%", REMOTE_DNS);
    content = content.replace("%FIREWALLA_ALTERNATIVE_DNS_PORT%", REMOTE_DNS_PORT);
    content = content.replace("%FIREWALLA_IPNETWORK_FILE_PRIMARY%", `${f.getTempFolder()}/country/CN.ip4`);
    content = content.replace("%FIREWALLA_IPNETWORK_FILE_ALTERNATIVE%", `${__dirname}/overture_alternative.lst`);

    await fs.writeFileAsync(`${f.getRuntimeInfoFolder()}/overture.${this.name}.config.json`, content);
  }

  async prepareServiceConfig() {
    const configPath = `${f.getRuntimeInfoFolder()}/ss_client.${this.name}.rc`;
    let configContent = "";
    configContent += `FW_SS_REDIR_PORT=${this.ssRedirectPort}\n`;
    configContent += `FW_SS_CLIENT_PORT=${this.ssClientPort}\n`;
    configContent += `FW_SS_SERVER=${this.config.server}\n`;
    await fs.writeFileAsync(configPath, configContent);
  }

  // prepare the chnroute files
  async prepareCHNRoute() {
    log.info("Preparing CHNRoute...");

    // intended non-blocking execution
    (async() => {
      await delay(60000);
      const code = "CN";
      await countryUpdater.activateCountry(code);
      const chain = `FW_SHADOWSOCKS_${this.name}`;
      await exec(wrapIptables(`sudo iptables -w -t nat -I ${chain} -p tcp -m set --match-set c_bd_country:CN_set dst -j RETURN`));
    })()
  }

  isStarted() {
    return this.started;
  }

  async statusCheck() {
    const cmd = `curl -m 10 -s -w 'X12345X%{time_appconnect}X12345X\n' -o  /dev/null --socks5-hostname localhost:${this.ssClientPort} https://google.com`;
    log.debug("checking cmd", cmd);
    try {
      const result = await exec(cmd);
      if(result.stdout) {
        const timeStrings = result.stdout.split("\n").filter((x) => x.match(/X12345X.*X12345X/));
        if(!_.isEmpty(timeStrings)) {
          const time = timeStrings[0].replace('X12345X', '').replace('X12345X', '');
          return {
            time: Number(time),
            status: true
          };
        }
      }
    } catch(err) {
      log.error(`ss server ${this.name} is not available.`, err.message);
      log.debug(err);
    }
    return {
      status: false
    };
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

  async clearConfig() {
    return rclient.delAsync(ssConfigKey);
  }

}

module.exports = SSClient;

