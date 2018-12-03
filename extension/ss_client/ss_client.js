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

const dnsForwarderBinary = `${binaryFolder}/dns_forwarder`;
const redirectionBinary = `${binaryFolder}/fw_ss_redir`;
const chinaDNSBinary = `${binaryFolder}/chinadns`;
const ssClientBinary = `${binaryFolder}/fw_ss_client`;

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

class SSClient {
  constructor(config, options) {
    if(!config) {
      throw new Error("Invalid name or config when new SSClient");
    }

    options = options || {}
    
    this.name = `${config.server}:${config.server_port}`;
    this.config = config;
    this.options = options;
    this.started = false;
    this.statusCheckTimer = null;

    log.info(`Creating ss client ${this.name}, config: ${require('util').inspect(this.config, {depth: null})}, options, ${require('util').inspect(this.options, {depth: null})}`);
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
    return this.options.redirPort || localRedirectionPort; // by default 8820
  }
  
  getLocalPort() {
    return this.options.localPort || localSSClientPort; // by default 8822
  }
  
  getChinaDNSPort() {
    return this.options.chinaDNSPort || chinaDNSPort; // by default 8854
  }
  
  getDNSForwardPort() {
    return this.options.dnsForwarderPort || localDNSForwarderPort; // by default 8857
  }
  
  async start() {
    log.info("Starting SS...");

    const options = this.options;
    
    try {
      await this.stop();
      await this._createConfigFile();
      await this._startDNSForwarder();
      await this._startRedirection();
      await this._startSSClient();
      options.gfw && await this._enableChinaDNS();
      await this._enableIptablesRule();

      if(!this.statusCheckTimer) {
        this.statusCheckTimer = setInterval(() => {
//          statusCheck()
        }, 1000 * 60) // check status every minute
        log.info("Status check timer installed")
      }
      this.started = true;
      
    } catch(err) {
      log.error("Failed to start SS, err:", err);
      // when any err occurs, revoke ss_client
      await this.stop();
    }
  }

  async stop() {

    log.info("Stopping everything on ss_client");

    if(this.statusCheckTimer) {
      clearInterval(this.statusCheckTimer)
      this.statusCheckTimer = null
      log.info("status check timer is stopped")
    }

    await this._disableIptablesRule().catch(() => {});
    await this._disableChinaDNS().catch(() => {});
    await this._stopSSClient().catch(() => {});
    await this._stopRedirection().catch(() => {});
    await this._stopDNSForwarder().catch(() => {});
    
    this.started = false;
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

    if(this.options.gfw) {
      port = this.getChinaDNS();
    } else {
      port = this.getDNSForwardPort();
    }

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
    return jsonfileWrite(this.getConfigPath(), this.config);
  }

  async _startDNSForwarder() {
    const cmd = `${dnsForwarderBinary} -b 127.0.0.1 -p ${this.getDNSForwardPort()} -s ${remoteDNS}:${remoteDNSPort}`

    log.info("dns forwarder cmd:", cmd, {})

    const process = p.spawn(cmd, {shell: true})

    process.on('exit', (code, signal) => {
      if(code !== 0) {
        log.error("dns forwarder exited with error:", code, signal, {})
      } else {
        log.info("dns forwarder exited successfully!")
      }
    })
  }

  async _startRedirection() {
    const cmd = util.format("%s -c %s -l %d -f %s -b %s",
      redirectionBinary,
      this.getConfigPath(),
      this.getRedirPort(),
      this.getRedirPIDPath(),
      localRedirectionAddress);

    log.info("Running cmd:", cmd);
    
    return exec(cmd);
  }

  async _enableChinaDNS() {
    let localDNSServers = sysManager.myDNS();
    if(localDNSServers == null || localDNSServers.length == 0) {
      // only use 114 dns server if local dns server is not available (NOT LIKELY)
      localDNSServers = ["114.114.114.114"];
    }

    const dnsConfig = util.format("%s,%s:%d",
      localDNSServers[0],
      "127.0.0.1",
      localDNSForwarderPort
    )

    const args = util.format("-m -c %s -p %d -s %s", chnrouteFile, chinaDNSPort, dnsConfig);

    log.info("Running cmd:", chinaDNSBinary, args);

    const chinadns = p.spawn(chinaDNSBinary, args.split(" "), {detached:true});

    chinadns.on('close', (code) => {
      log.info("chinadns exited with code", code);
    });
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

}

module.exports = SSClient;

