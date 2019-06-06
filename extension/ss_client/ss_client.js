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

const log = require("../../net2/logger.js")(__filename, "info");

const fs = require('fs');
const util = require('util');
const jsonfile = require('jsonfile');
const p = require('child_process');

const DNSMASQ = require('../dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec

const Promise = require('bluebird')

const jsonfileWrite = Promise.promisify(jsonfile.writeFile)
Promise.promisifyAll(fs);

const f = require('../../net2/Firewalla.js');
const fHome = f.getFirewallaHome();

const SysManager = require('../../net2/SysManager');
const sysManager = new SysManager();

const extensionFolder = fHome + "/extension/ss_client";

const ssConfigKey = "scisurf.config";

const enableIptablesBinary = extensionFolder + "/add_iptables_template.sh";
const disableIptablesBinary = extensionFolder + "/remove_iptables_template.sh";

const onlineScript = extensionFolder + "/iptables_online.sh";
const offlineScript = extensionFolder + "/iptables_offline.sh";

const wrapIptables = require('../../net2/Iptables.js').wrapIptables;

var ssConfig = null;

const localSSClientPort = 8822;
const localSSClientAddress = "0.0.0.0";

let localRedirectionPort = 8820;
const localRedirectionAddress = "0.0.0.0";

const localDNSForwarderPort = 8857
const remoteDNS = "8.8.8.8"
const remoteDNSPort = "53"

const OVERTURE_PORT = 8854;
const REMOTE_DNS = "8.8.8.8";
const REMOTE_DNS_PORT = 53;

const _ = require('lodash');

const CountryUpdater = require('../../control/CountryUpdater.js')
const countryUpdater = new CountryUpdater()

class SSClient {
  constructor(config = {}) {
    if(!config) {
      throw new Error("Invalid name or config when new SSClient");
    }
    
    this.name = config.name || "default";
    this.config = config;
    this.started = false;
    this.statusCheckTimer = null;

    log.info(`Creating ss client ${this.name}...`);//, config: ${require('util').inspect(this.config, {depth: null})}, options, ${require('util').inspect(this.options, {depth: null})}`);
  }
  
  // This only starts the service, call redirectTraffic to redirect devices traffic
  async start() {
    log.info("Starting SS backend service...");    
    await this._createConfigFile();
    await exec(`sudo systemctl restart ss_client@${this.name}`);
    log.info("Started SS backend service.");
  }


  async stop() {
    log.info(`Stopping SS backend service ${this.name}...`);
    await exec(`sudo systemctl stop ss_client@${this.name}`);
    log.info(`Stopped SS backend service ${this.name}.`);
  }

    
  async redirectTraffic() {
    // set dnsmasq upstream to overture
    const upstreamDNS = `127.0.0.1#${OVERTURE_PORT}`;
    await dnsmasq.setUpstreamDNS(upstreamDNS);

    // reroute all devices's traffic to ss special chain
    const chain = `FW_SHADOWSOCKS_${this.name}`;
    await exec(wrapIptables(`sudo iptables -w -t nat -A PREROUTING -p tcp -j ${chain}`));
  }

  async unRedirectTraffic() {
    // unreroute all traffic
    const chain = `FW_SHADOWSOCKS_${this.name}`;
    await exec(wrapIptables(`sudo iptables -w -t nat -A PREROUTING -p tcp -j ${chain}`));

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
  
  getRedirPIDPath() {
    return `${f.getRuntimeInfoFolder()}/ss_client.${this.name}.redir.pid`;
  }
  
  getClientPidPath() {
    return `${f.getRuntimeInfoFolder()}/ss_client.${this.name}.client.pid`;
  }
  
  // ports
  getRedirPort() {
    return this.config.redirPort || localRedirectionPort; // by default 8820
  }
  
  getLocalPort() {
    return this.config.localPort || localSSClientPort; // by default 8822
  }
  
  getChinaDNSPort() {
    return this.config.chinaDNSPort || chinaDNSPort; // by default 8854
  }
  
  getDNSForwardPort() {
    return this.config.dnsForwarderPort || localDNSForwarderPort; // by default 8857
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
    content = content.replace("%FIREWALLA_OVERTURE_PORT%", OVERTURE_PORT);
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
    await fs.writeFileAsync(configPath, "");
  }

  // prepare the chnroute files
  async prepareCHNRoute() {
    log.info("Preparing CHNRoute...")
    await countryUpdater.activateCountry("CN");
  }

  async _enableIptablesRule() {

    const cmd = util.format("FW_NAME=%s FW_SS_SERVER=%s FW_SS_LOCAL_PORT=%s FW_REMOTE_DNS=%s FW_REMOTE_DNS_PORT=%s %s",
      this.name,
      this.config.server,
      this.getRedirPort(),
      remoteDNS,
      remoteDNSPort,
      enableIptablesBinary);

    log.info("Running cmd:", cmd);
    
    return exec(cmd);
  }
    
  async _disableIptablesRule() {
    const cmd = util.format("FW_NAME=%s %s",
      this.name,
      disableIptablesBinary);
    
    log.info("Running cmd:", cmd);
    return exec(cmd).catch((err) => {
//      log.error("Got error when disable ss iptables rule set:", err);
    });
  }

  isStarted() {
    return this.started;
  }
  
  async statusCheck() {
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

}

module.exports = SSClient;

