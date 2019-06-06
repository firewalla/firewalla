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

// Files
const platformLoader = require('../../platform/PlatformLoader.js');
const platformName = platformLoader.getPlatformName();

const binaryFolder = `${extensionFolder}/bin.${platformName}`;

const ssConfigKey = "scisurf.config";

const enableIptablesBinary = extensionFolder + "/add_iptables_template.sh";
const disableIptablesBinary = extensionFolder + "/remove_iptables_template.sh";

const onlineScript = extensionFolder + "/iptables_online.sh";
const offlineScript = extensionFolder + "/iptables_offline.sh";

const chnrouteFile = extensionFolder + "/chnroute";

var ssConfig = null;

const localSSClientPort = 8822;
const localSSClientAddress = "0.0.0.0";

let localRedirectionPort = 8820;
const localRedirectionAddress = "0.0.0.0";
let chinaDNSPort = 8854;
let chinaDNSAddress = "127.0.0.1";

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

    options = options || {}
    
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
    await exec("sudo systemctl restart ss_client");
    log.info("Started SS backend service.");
  }


  async stop() {
    log.info("Stopping SS backend service...");
    await exec("sudo systemctl stop ss_client");
    log.info("Stopped SS backend service...");
  }

  async resetConfig() {
    // do nothing
  }

  // file paths
  getConfigPath() {
    return `${f.getUserConfigFolder()}/ss_client.${this.name}.config.json`;
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
  
  
  async redirectTraffic() {

  }

  async unRedirectTraffic() {

  }


  async bypassSSServer() {
    const chainName = `FW_SHADOWSOCKS${this.name}`;

    if(this.ssServers) {
      for (let i = 0; i < this.ssServers.length; i++) {
        const ssServer = this.ssServers[i];
        const cmd = `sudo iptables -w -t nat -I ${chainName} -d ${ssServer} -j RETURN`;
        await exec(cmd).catch((err) => {});
      }
    }
  }

  async unbypassSSServer() {
    const chainName = `FW_SHADOWSOCKS${this.name}`;

    if(this.ssServers) {
      for (let i = 0; i < this.ssServers.length; i++) {
        const ssServer = this.ssServers[i];
        const cmd = `sudo iptables -w -t nat -D ${chainName} -d ${ssServer} -j RETURN`;
        await exec(cmd).catch((err) => {});
      }
    }
  }
  
  async goOnline() {
    const cmd = util.format("FW_NAME=%s FW_SS_SERVER=%s FW_SS_LOCAL_PORT=%s FW_REMOTE_DNS=%s FW_REMOTE_DNS_PORT=%s %s",
      this.name,
      this.config.server,
      this.getRedirPort(),
      remoteDNS,
      remoteDNSPort,
      onlineScript);

    log.info("Running cmd:", cmd);

    await exec(cmd).catch((err) => {
      log.error(`Got error when ${this.name} go online:`, err)
    });

    await this.bypassSSServer();

    let port = null;

    await dnsmasq.setUpstreamDNS(port);

    log.info("dnsmasq upstream dns is set to", this.getChinaDNS());
  }
  
  async goOffline() {
    await dnsmasq.setUpstreamDNS(null)

    await this.unbypassSSServer();

    const cmd = util.format("FW_NAME=%s FW_SS_SERVER=%s FW_SS_LOCAL_PORT=%s FW_REMOTE_DNS=%s FW_REMOTE_DNS_PORT=%s %s",
      this.name,
      this.config.server,
      this.getRedirPort(),
      remoteDNS,
      remoteDNSPort,
      offlineScript);

    log.info("Running cmd:", cmd);
    return exec(cmd).catch((err) => {
      log.error(`Got error when ${this.name} go offline:`, err);
    });
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
    content = content.replace("%FIREWALLA_IPNETWORK_FILE_PRIMARY%", chnrouteFile);
    content = content.replace("%FIREWALLA_IPNETWORK_FILE_ALTERNATIVE%", `${__dirname}/overture_alternative.lst`);

    await fs.writeFileAsync(`${f.getRuntimeInfoFolder()}/overture.${this.name}.config.json`, content);
  }

  async prepareServiceConfig() {
    const configPath = `${f.getRuntimeInfoFolder()}/ss_client.${this.name}.rc`;
    await fs.writeFileAsync(configPath, "");
  }

  // prepare the chnroute files
  async prepareCHNRoute() {
    log.info("Preparing CHNRoute")
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
  
  /*
   * /home/pi/firewalla/extension/ss_client/fw_ss_client
   *   -c /home/pi/.firewalla/config/ss_client.config.json
   *   -l 8822
   *   -f /home/pi/.firewalla/run/ss_client.pid
    *  -b 0.0.0.0
   */
  async _startSSClient() {
    const cmd = `${ssClientBinary} -c ${this.getConfigPath()} -l ${this.getLocalPort()} -b ${localSSClientAddress} -f ${this.getClientPidPath()}`;
    log.info("Starting ss client...");
    return exec(cmd);
  }
  
  // STOP
//   await _disableIptablesRuleAsync().catch(() => {});
// await _disableChinaDNSAsync().catch(() => {});
// await _stopSSClient().catch(() => {});
// await _stopRedirectionAsync().catch(() => {});
// await _stopDNSForwarderAsync().catch(() => {});
// await _disableIpsetAsync().catch(() => {});

  async _disableIptablesRule() {
    const cmd = util.format("FW_NAME=%s %s",
      this.name,
      disableIptablesBinary);
    
    log.info("Running cmd:", cmd);
    return exec(cmd).catch((err) => {
//      log.error("Got error when disable ss iptables rule set:", err);
    });
  }

  async _disableChinaDNS() {
    const cmd = `pkill -f 'chinadns.*p ${this.getChinaDNSPort()} .*${this.getDNSForwardPort()}'`;
    
    return exec(cmd).catch((err) => {
//      log.error("Got error when disable china dns:", err);
    });
  }
  
  async _stopSSClient() {
    const cmd = `pkill -f 'fw_ss_client.*${this.getClientPidPath()}'`;
    log.info("Stopping ss client...", cmd);
    return exec(cmd).catch((err) => {
//      log.info("Failed to stop ss client", err);
    });
  }

  async _stopRedirection() {
    const cmd = `pkill 'fw_ss_redir.*${this.getRedirPIDPath()}'`;
    log.info("Running cmd:", cmd);
    
    return exec(cmd).catch((err) => {
//      log.error("Failed to stop redir:", err);
    });
  }
  
  async _stopDNSForwarder() {
    const cmd = `pkill 'dns_forwarder.*${this.getDNSForwardPort()}'`;
    log.info("Running cmd:", cmd);

    return exec(cmd).catch((err) => {
//      log.error("Failed to stop redir:", err);
    });
  }
  

  
  getChinaDNS() {
    return chinaDNSAddress + "#" + this.getChinaDNSPort();
  }
  
  async cleanup() {
    // TODO: cleanup all temp files
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
      log.debug("Failed to destroy chnroute:", err);
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

module.exports = SSClient;

