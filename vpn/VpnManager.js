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

var instance = null;
const log = require("../net2/logger.js")(__filename)
const iptable = require("../net2/Iptables");
const wrapIptables = iptable.wrapIptables;
const cp = require('child_process');
const exec = require('child_process').exec
const sysManager = require('../net2/SysManager.js');
const firewalla = require('../net2/Firewalla.js');
const pl = require('../platform/PlatformLoader.js');
const platform = pl.getPlatform();
const fHome = firewalla.getFirewallaHome();
const ip = require('ip');
const mode = require('../net2/Mode.js');

const fs = require('fs');

const sem = require('../sensor/SensorEventManager.js').getInstance();
const util = require('util');
const Promise = require('bluebird');
const execAsync = util.promisify(cp.exec);
const writeFileAsync = util.promisify(fs.writeFile);
const readFileAsync = util.promisify(fs.readFile);
const readdirAsync = util.promisify(fs.readdir);
const statAsync = util.promisify(fs.stat);

const pclient = require('../util/redis_manager.js').getPublishClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();

const UPNP = require('../extension/upnp/upnp.js');
const Message = require('../net2/Message.js');

const moment = require('moment');

class VpnManager {
  constructor() {
    if (instance == null) {
      this.upnp = new UPNP();
      if (firewalla.isMain()) {
        sclient.on("message", async (channel, message) => {
          switch (channel) {
            case Message.MSG_SYS_NETWORK_INFO_RELOADED:
              // update UPnP port mapping
              try {
                if (!this.started)
                  return;
                this.portmapped = await this.addUpnpPortMapping(this.protocol, this.localPort, this.externalPort, "Firewalla VPN").catch((err) => {
                  log.error("Failed to set Upnp port mapping", err);
                });
              } catch(err) {
                log.error("Failed to set iptables", err);
              }
            default:
          }
        });

        sclient.subscribe(Message.MSG_SYS_NETWORK_INFO_RELOADED);
      }
      instance = this;
      this.instanceName = "server"; // defautl value
    }
    return instance;
  }

  install(instance, callback) {
    let install1_cmd = util.format('cd %s/vpn; sudo -E ./install1.sh %s', fHome, instance);
    exec(install1_cmd, (err, out, code) => {
      if (err) {
        log.error("VPNManager:INSTALL:Error", "Unable to install1.sh for " + instance, err);
      }
      if (err == null) {
        // !! Pay attention to the parameter "-E" which is used to preserve the
        // enviornment variables when running sudo commands
        const installLockFile = "/dev/shm/vpn_install2_lock_file";
        let install2_cmd = util.format("cd %s/vpn; flock -n %s -c 'sudo -E ./install2.sh %s'; sync", fHome, installLockFile, instance);
        log.info("VPNManager:INSTALL:cmd", install2_cmd);
        exec(install2_cmd, (err, out, code) => {
          if (err) {
            log.error("VPNManager:INSTALL:Error", "Unable to install2.sh", err);
            if (callback) {
              callback(err, null);
            }
            return;
          }
          log.info("VPNManager:INSTALL:Done");
          this.instanceName = instance;
          if (callback)
            callback(null, null);
        });
      } else {
        if (callback)
          callback(err, null);
      }
    });
  }

  async installAsync(instance) {
    return util.promisify(this.install).bind(this)(instance)
  }

  async setIptables() {
    const serverNetwork = this.serverNetwork;
    if (!serverNetwork) {
      return;
    }
    log.info("VpnManager:SetIptables", serverNetwork);

    const commands =[
      // delete this rule if it exists, logical opertion ensures correct execution
      wrapIptables(`sudo iptables -w -t nat -D FW_POSTROUTING -s ${serverNetwork}/24 -j MASQUERADE`),
      // insert back as top rule in table
      `sudo iptables -w -t nat -I FW_POSTROUTING 1 -s ${serverNetwork}/24 -j MASQUERADE`
    ];
    await iptable.run(commands);
    this._currentServerNetwork = serverNetwork;
  }

  async unsetIptables() {
    let serverNetwork = this.serverNetwork;
    if (this._currentServerNetwork)
      serverNetwork = this._currentServerNetwork;
    if (!serverNetwork) {
      return;
    }
    log.info("VpnManager:UnsetIptables", serverNetwork);
    const commands = [
      wrapIptables(`sudo iptables -w -t nat -D FW_POSTROUTING -s ${serverNetwork}/24 -j MASQUERADE`),
    ];
    await iptable.run(commands);
    this._currentServerNetwork = null;
  }

  async removeUpnpPortMapping(opts) {
    if (!sysManager.myDefaultWanIp() || !ip.isPrivate(sysManager.myDefaultWanIp())) {
      log.info(`Defautl WAN IP ${sysManager.myDefaultWanIp()} is not a private IP, no need to remove upnp port mapping`);
      return false;
    }
    if (mode.isRouterModeOn()) {
      log.info(`VPN server UPnP port mapping is not used in router mode`);
      return false;
    }
    log.info("VpnManager:RemoveUpnpPortMapping", opts);
    let timeoutExecuted = false;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        timeoutExecuted = true;
        log.error("Failed to remove upnp port mapping due to timeout");
        resolve(false);
      }, 10000);
      this.upnp.removePortMapping(opts.protocol, opts.private, opts.public, (err) => {
        clearTimeout(timeout);
          if (!timeoutExecuted) {
            if (err)
              resolve(false);
            else
              resolve(true);
          }
      });
    });
  }

  async addUpnpPortMapping(protocol, localPort, externalPort, description) {
    if (!sysManager.myDefaultWanIp() || !ip.isPrivate(sysManager.myDefaultWanIp())) {
      log.info(`Defautl WAN IP ${sysManager.myDefaultWanIp()} is not a private IP, no need to add upnp port mapping`);
      return false;
    }
    if (mode.isRouterModeOn()) {
      log.info(`VPN server UPnP port mapping is not used in router mode`);
      return false;
    }
    log.info("VpnManager:AddUpnpPortMapping", protocol, localPort, externalPort, description);
    let timeoutExecuted = false;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        timeoutExecuted = true;
        log.error("Failed to add upnp port mapping due to timeout");
        resolve(false);
      }, 10000);
      this.upnp.addPortMapping(protocol, localPort, externalPort, description, (err) => {
        clearTimeout(timeout);
        if (!timeoutExecuted) {
          if (err)
            resolve(false);
          else
            resolve(true);
        }
      });
    });
  }

  async configure(config) {
    if (config) {
      if (config.serverNetwork) {
        if (this.serverNetwork && this.serverNetwork !== config.serverNetwork)
          this.needRestart = true;
        this.serverNetwork = config.serverNetwork;
      }
      if (config.netmask) {
        if (this.netmask && this.netmask !== config.netmask)
          this.needRestart = true;
        this.netmask = config.netmask;
      }
      if (config.localPort) {
        if (this.localPort && this.localPort !== config.localPort)
          this.needRestart = true;
        this.localPort = config.localPort;
      }
      if (config.externalPort) {
        if (this.externalPort && this.externalPort !== config.externalPort)
          this.needRestart = true;
        this.externalPort = config.externalPort;
      }
      if (config.protocol) {
        if (this.protocol && this.protocol !== config.protocol)
          this.needRestart = true;
        this.protocol = config.protocol;
      }
    }
    if (this.serverNetwork == null) {
      this.serverNetwork = this.generateNetwork();
      this.needRestart = true;
    }
    if (this.netmask == null) {
      this.netmask = "255.255.255.0";
      this.needRestart = true;
    }
    if (this.localPort == null) {
      this.localPort = "1194";
      this.needRestart = true;
    }
    if (this.externalPort == null) {
      this.externalPort = this.localPort;
      this.needRestart = true;
    }
    if (this.protocol == null) {
      this.protocol = platform.getVPNServerDefaultProtocol();
    }
    if (this.instanceName == null) {
      this.instanceName = "server";
      this.needRestart = true;
    }
    var mydns = sysManager.myDefaultDns()[0];
    if (mydns == null || mydns === "127.0.0.1") {
      mydns = "8.8.8.8"; // use google DNS as default
    }
    const confGenLockFile = "/dev/shm/vpn_confgen_lock_file";
    // sysManager.myIp() is not used in the below command
    const cmd = util.format("cd %s/vpn; flock -n %s -c 'sudo -E ./confgen.sh %s %s %s %s %s %s %s'; sync",
      fHome, confGenLockFile, this.instanceName, sysManager.myIp(), mydns, this.serverNetwork, this.netmask, this.localPort, this.protocol);
    log.info("VPNManager:CONFIGURE:cmd", cmd);
    await execAsync(cmd).catch((err) => {
      log.error("VPNManager:CONFIGURE:Error", "Unable to generate server config for " + this.instanceName, err);
      return null;
    });
      log.info("VPNManager:CONFIGURE:Done");
    return {
      serverNetwork: this.serverNetwork,
      netmask: this.netmask,
      localPort: this.localPort,
      externalPort: this.externalPort,
      protocol: this.protocol
    };
  }

  async killClient(addr) {
    if (!addr) return;
    const cmd = `echo "kill ${addr}" | nc -w 5 -q 2 localhost 5194`;
    await execAsync(cmd).catch((err) => {
      log.warn(`Failed to kill client with address ${addr}`, err);
    });
  }

  async getStatistics() {
    // statistics include client lists and rx/tx bytes
    let cmd = `systemctl is-active openvpn@${this.instanceName}`;
    return await execAsync(cmd).then(async () => {
      cmd = `echo "status" | nc -w 5 -q 2 localhost 5194 | tail -n +2`;
      /*
      OpenVPN CLIENT LIST
      Updated,Fri Aug  9 12:08:18 2019
      Common Name,Real Address,Bytes Received,Bytes Sent,Connected Since
      fishboneVPN1,192.168.7.92:57235,271133,174599,Fri Aug  9 12:06:03 2019
      ROUTING TABLE
      Virtual Address,Common Name,Real Address,Last Ref
      10.115.61.6,fishboneVPN1,192.168.7.92:57235,Fri Aug  9 12:08:17 2019
      GLOBAL STATS
      Max bcast/mcast queue length,1
      END
      */
      const result = await execAsync(cmd).catch((err) => null);
      if (result && result.stdout) {
        const lines = result.stdout.split("\n").map(line => line.trim());
        let currentSection = null;
        let colNames = [];
        const clientMap = {};
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          switch (line) {
            case "OpenVPN CLIENT LIST":
              i += 1; // skip one line, which is something like "Updated,Thu Aug  8 18:24:32 2019"
              // falls through
            case "ROUTING TABLE":
              currentSection = line;
              i += 1;
              colNames = lines[i].split(",");
              continue;
            case "GLOBAL STATS":
            case "END":
              // do not process these sections
              currentSection = line;
              colNames = [];
              continue;
            default:
              // fall through
          }
          switch (currentSection) {
            // line contains contents of the corresponding section
            case "OpenVPN CLIENT LIST": {
              const values = line.split(",");
              const clientDesc = {};
              for (let j in colNames) {
                switch (colNames[j]) {
                  case "Common Name":
                    clientDesc.cn = values[j];
                    break;
                  case "Real Address":
                    clientDesc.addr = values[j];
                    break;
                  case "Bytes Received":
                    clientDesc.rxBytes = values[j];
                    break;
                  case "Bytes Sent":
                    clientDesc.txBytes = values[j];
                    break;
                  case "Connected Since":
                    clientDesc.since = Math.floor(new Date(values[j]).getTime() / 1000);
                    break;
                  default:
                }
              }
              if (clientMap[clientDesc.addr]) {
                clientMap[clientDesc.addr] = Object.assign({}, clientMap[clientDesc.addr], clientDesc);
              } else {
                clientMap[clientDesc.addr] = clientDesc;
              }
              break;
            }
            case "ROUTING TABLE": {
              const values = line.split(",");
              const clientDesc = {};
              for (let j in colNames) {
                switch (colNames[j]) {
                  case "Virtual Address":
                    break;
                  case "Common Name":
                    clientDesc.cn = values[j];
                    break;
                  case "Real Address":
                    clientDesc.addr = values[j];
                    break;
                  case "Last Ref":
                    clientDesc.lastActive = Math.floor(new Date(values[j]).getTime() / 1000);
                    break;
                  default:
                }
              }
              if (clientMap[clientDesc.addr]) {
                clientMap[clientDesc.addr] = Object.assign({}, clientMap[clientDesc.addr], clientDesc);
              } else {
                clientMap[clientDesc.addr] = clientDesc;
              }
              break;
            }
            default:
          }
        }
        return {clients: Object.values(clientMap)};
      } else {
        return {clients: []};
      }
    }).catch(() => {
      return {clients: []};
    })
  }

  async stop() {
    try {
      if (this.refreshTask)
        clearInterval(this.refreshTask);
      await this.removeUpnpPortMapping({
        protocol: this.protocol,
        private: this.localPort,
        public: this.externalPort
      });
      this.portmapped = false;
      log.info("Stopping OpenVPN ...");
      await execAsync("sudo systemctl stop openvpn@" + this.instanceName);
      this.started = false;
      await this.unsetIptables();
    } catch (err) {
      log.error("Failed to stop OpenVPN", err);
    }
    return {
      state: false,
      serverNetwork: this.serverNetwork,
      netmask: this.netmask,
      localPort: this.localPort,
      externalPort: this.externalPort,
      portmapped: this.portmapped,
      protocol: this.protocol
    };
  }

  async start() {
    sem.sendEventToFireMain({
      type: "PublicIP:Check",
      message: "VPN server starting, check public IP"
    })

    // check whatever VPN server is running or not
    if (this.started && !this.needRestart) {
      log.info("VpnManager::StartedAlready");

      return {
        state: true,
        serverNetwork: this.serverNetwork,
        netmask: this.netmask,
        localPort: this.localPort,
        externalPort: this.externalPort,
        portmapped: this.portmapped,
        protocol: this.protocol
      };
      // callback(null, this.portmapped, this.portmapped, this.serverNetwork, this.localPort);
    }

    if (this.instanceName == null) {
      log.error("Server instance is not installed yet.");
      return {
        state: false
      };
    }

    if (!this.refreshTask) {
      this.refreshTask = setInterval(async () => {
        this.upnp.gw = sysManager.myDefaultGateway();
        // extend upnp lease once every 10 minutes in case router flushes it unexpectedly
        this.portmapped = await this.addUpnpPortMapping(this.protocol, this.localPort, this.externalPort, "Firewalla VPN").catch((err) => {
          log.error("Failed to set Upnp port mapping", err);
        });
      }, 600000);
    }

    await this.removeUpnpPortMapping({
      protocol: this.protocol,
      private: this.localPort,
      public: this.externalPort
    }).catch((err)=> {
      log.error("Failed to remove Upnp port mapping", err);
    });
    this.portmapped = false;
    let op = "start";
    if (!this.started || this.needRestart) {
      op = "restart";
      this.needRestart = false;
    }
    log.info("VpnManager:Start:" + this.instanceName);
    try {
      await execAsync(util.format("sudo systemctl %s openvpn@%s", op, this.instanceName));
      this.started = true;
      await this.setIptables();
      this.portmapped = await this.addUpnpPortMapping(this.protocol, this.localPort, this.externalPort, "Firewalla VPN").catch((err) => {
        log.error("Failed to set Upnp port mapping", err);
        return false;
      });
      log.info("VpnManager:UPNP:SetDone", this.portmapped);
      const vpnSubnet = ip.subnet(this.serverNetwork, this.netmask);
      pclient.publishAsync("System:VPNSubnetChanged", this.serverNetwork + "/" + vpnSubnet.subnetMaskLength);
      return {
        state: true,
        serverNetwork: this.serverNetwork,
        netmask: this.netmask,
        localPort: this.localPort,
        externalPort: this.externalPort,
        portmapped: this.portmapped,
        protocol: this.protocol
      };
    } catch (err) {
      log.info("Failed to start VPN", err);
      await this.stop();
      return {
        state: false,
        serverNetwork: this.serverNetwork,
        netmask: this.netmask,
        localPort: this.localPort,
        externalPort: this.externalPort,
        portmapped: this.portmapped
      };
    }
  }

  static generatePassword(len) {
    var length = len,
      charset = "0123456789",
      retVal = "";
    for (var i = 0, n = charset.length; i < length; ++i) {
      retVal += charset.charAt(Math.floor(Math.random() * n));
    }
    return retVal;
  }

  generateNetwork() {
    // random segment from 20 to 199
    const seg1 = Math.floor(Math.random() * 180 + 20);
    const seg2 = Math.floor(Math.random() * 180 + 20);
    return "10." + seg1 + "." + seg2 + ".0";
  }

  static getSettingsDirectoryPath(commonName) {
    return `${process.env.HOME}/ovpns/${commonName}`;
  }

  static async configureClient(commonName, settings) {
    settings = settings || {};
    const configRC = [];
    const configCCD = [];
    configCCD.push("comp-lzo no"); // disable compression in client-config-dir
    configCCD.push("push \"comp-lzo no\"");
    const clientSubnets = [];
    for (let key in settings) {
      const value = settings[key];
      switch (key) {
        case "clientSubnets":
          // value is array of cidr subnets
          for (let cidr of value) {
            // add iroute to client config file
            const subnet = ip.cidrSubnet(cidr);
            configCCD.push(`iroute ${subnet.networkAddress} ${subnet.subnetMask}`);
            clientSubnets.push(`${subnet.networkAddress}/${subnet.subnetMaskLength}`);
          }
          configRC.push(`CLIENT_SUBNETS="${clientSubnets.join(',')}"`);
          break;
        default:
      }
    }
    // check if there is conflict between client subnets and Firewalla's subnets
    for (let clientSubnet of clientSubnets) {
      const ipSubnets = clientSubnet.split('/');
      if (ipSubnets.length != 2)
        throw `${clientSubnet} is not a valid CIDR subnet`;
      const ipAddr = ipSubnets[0];
      const maskLength = ipSubnets[1];
      if (!ip.isV4Format(ipAddr))
        throw `${clientSubnet} is not a valid CIDR subnet`;
      if (isNaN(maskLength) || !Number.isInteger(Number(maskLength)) || Number(maskLength) > 32 || Number(maskLength) < 0)
        throw `${clientSubnet} is not a valid CIDR subnet`;
      const clientSubnetCidr = ip.cidrSubnet(clientSubnet);
      for (const iface of sysManager.getLogicInterfaces()) {
        const mySubnetCidr = iface.subnet && ip.cidrSubnet(iface.subnet);
        if (!mySubnetCidr)
          continue;
        if (mySubnetCidr.contains(clientSubnetCidr.firstAddress) || clientSubnetCidr.contains(mySubnetCidr.firstAddress))
          throw `${clientSubnet} conflicts with subnet of ${iface.name} ${iface.subnet}`;
      }
    }
    // save settings to files
    await execAsync(`mkdir -p ${VpnManager.getSettingsDirectoryPath(commonName)}`);
    const configRCFile = `${VpnManager.getSettingsDirectoryPath(commonName)}/${commonName}.rc`;
    const configJSONFile = `${VpnManager.getSettingsDirectoryPath(commonName)}/${commonName}.json`;
    const configCCDFileTmp = `${VpnManager.getSettingsDirectoryPath(commonName)}/${commonName}.ccd`;
    const configCCDFile = `/etc/openvpn/client_conf/${commonName}`;
    await writeFileAsync(configRCFile, configRC.join('\n'), 'utf8');
    await writeFileAsync(configJSONFile, JSON.stringify(settings), 'utf8');
    await writeFileAsync(configCCDFileTmp, configCCD.join('\n'), 'utf8');
    await execAsync(`sudo cp ${configCCDFileTmp} ${configCCDFile}`);
    const cmd = `sudo chmod 644 /etc/openvpn/client_conf/${commonName}`;
    await execAsync(cmd).catch((err) => {
      log.error(`Failed to change permisson: ${cmd}`, err);
    });
  }

  static async getSettings(commonName) {
    const configJSONFile = `${VpnManager.getSettingsDirectoryPath(commonName)}/${commonName}.json`;
    if (fs.existsSync(configJSONFile)) {
      const config = await readFileAsync(configJSONFile, 'utf8').then((str) => {
        return JSON.parse(str);
      }).catch((err) => {
        log.error("Failed to read settings from " + configJSONFile, err);
        return {};
      })
      return config;
    } else {
      return null;
    }
  }

  static async getAllSettings() {
    const settingsDirectory = `${process.env.HOME}/ovpns`;
    await execAsync(`mkdir -p ${settingsDirectory}`);
    const allSettings = {};
    const filenames = await readdirAsync(settingsDirectory, 'utf8');
    for (let filename of filenames) {
      const fileEntry = await statAsync(`${settingsDirectory}/${filename}`);
      if (fileEntry.isDirectory()) {
        // directory contains .json and .rc file
        const settingsFilePath = `${VpnManager.getSettingsDirectoryPath(filename)}/${filename}.json`;
        if (fs.existsSync(settingsFilePath)) {
          const settings = await readFileAsync(settingsFilePath, 'utf8').then((content) => {
            return JSON.parse(content)
          }).catch((err) => {
            log.error("Failed to read settings from " + settingsFilePath, err);
            return null;
          });
          if (settings)
            allSettings[filename] = settings;
        }
      }
    }
    return allSettings;
  }

  static async revokeOvpnFile(commonName) {
    if (!commonName || commonName.trim().length == 0)
      return;
    const vpnLockFile = "/dev/shm/vpn_gen_lock_file";
    const cmd = util.format("cd %s/vpn; flock -n %s -c 'sudo -E ./ovpnrevoke.sh %s; sync'", fHome, vpnLockFile, commonName);
    log.info("VPNManager:Revoke", cmd);
    await execAsync(cmd).catch((err) => {
      log.error("Failed to revoke VPN profile " + commonName, err);
    });
  }

  static getOvpnFile(commonName, password, regenerate, externalPort, callback) {
    let ovpn_file = util.format("%s/ovpns/%s.ovpn", process.env.HOME, commonName);
    let ovpn_password = util.format("%s/ovpns/%s.ovpn.password", process.env.HOME, commonName);
    const protocol = platform.getVPNServerDefaultProtocol();

    log.info("Reading ovpn file", ovpn_file, ovpn_password, regenerate);

    fs.readFile(ovpn_file, 'utf8', (err, ovpn) => {
      if (ovpn != null && regenerate == false) {
        let password = fs.readFileSync(ovpn_password, 'utf8').trim();
        log.info("VPNManager:Found older ovpn file: " + ovpn_file);
        (async () => {
          const timestamp = await VpnManager.getVpnConfigureTimestamp(commonName);
          callback(null, ovpn, password, timestamp);
        })();
        return;
      }

      if (password == null) {
        password = VpnManager.generatePassword(5);
      }

      let ip = sysManager.myDDNS();
      if (ip == null) {
        ip = sysManager.publicIp;
      }

      const vpnLockFile = "/dev/shm/vpn_gen_lock_file";

      let cmd = util.format("cd %s/vpn; flock -n %s -c 'sudo -E ./ovpngen.sh %s %s %s %s %s'; sync",
        fHome, vpnLockFile, commonName, password, ip, externalPort, protocol);
      log.info("VPNManager:GEN", cmd);
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          log.error("VPNManager:GEN:Error", "Unable to ovpngen.sh", err);
        }
        fs.readFile(ovpn_file, 'utf8', (err, ovpn) => {
          if (callback) {
            (async () => {
              const timestamp = await VpnManager.getVpnConfigureTimestamp(commonName);
              callback(err, ovpn, password, timestamp);
            })();
          }
        });
      });
    });
  }

  static async getVpnConfigureTimestamp(commonName) {
    if (!commonName || commonName.trim().length == 0)
      return null;

    const cmd = "sudo cat /etc/openvpn/easy-rsa/keys/index.txt";
    const result = await execAsync(cmd);
    if (result.stderr !== "") {
      log.error("Failed to read file.", result.stderr);
      return null;
    }

    try {
      const lines = result.stdout.toString("utf8").split('\n');
      for (var i = 0; i < lines.length; i++) {
        const contents = lines[i].split(/\t/);
        if (contents.length != 6)
          continue;

        if (!(contents[0] == "V" && contents[5] && contents[5].indexOf('/CN=' + commonName + '/') > -1))
          continue;

        return moment(contents[1], "YYMMDDHHmmssZ").subtract(3650, 'days').format('YYYY-MM-DD HH:mm:ss');
      }
    } catch(err) {
      log.error("Failed to get timestamp:", err);
    }

    return null;
  }
}

module.exports = VpnManager;
