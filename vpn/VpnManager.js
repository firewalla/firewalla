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

var instance = null;
const log = require("../net2/logger.js")(__filename)
const iptable = require("../net2/Iptables");
const wrapIptables = iptable.wrapIptables;
const cp = require('child_process');
const exec = require('child_process').exec
const SysManager = require('../net2/SysManager.js');
const sysManager = new SysManager('info');
const firewalla = require('../net2/Firewalla.js');
const fHome = firewalla.getFirewallaHome();
const ip = require('ip');

const fs = require('fs');

const sem = require('../sensor/SensorEventManager.js').getInstance();
const util = require('util');
const Promise = require('bluebird');
const execAsync = util.promisify(cp.exec);

const pclient = require('../util/redis_manager.js').getPublishClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();

const UPNP = require('../extension/upnp/upnp.js');

class VpnManager {
  constructor() {
    if (instance == null) {
      this.upnp = new UPNP(sysManager.myGateway());
      if (firewalla.isMain()) {
        sclient.on("message", async (channel, message) => {
          switch (channel) {
            case "System:IPChange":
              // update SNAT rule in iptables
              try {
                // sysManager.myIp() only returns latest IP of Firewalla. Should unset old rule with legacy IP before add new rule
                await this.unsetIptables();
                await this.setIptables()
              } catch(err) {
                log.error("Failed to set iptables", err);
              }
            default:
          }
        });

        sclient.subscribe("System:IPChange");
      }
      instance = this;
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

  async setIptables() {
    const serverNetwork = this.serverNetwork;
    const localIp = sysManager.myIp();
    this._currentLocalIp = localIp;
    if (!serverNetwork) {
      return;
    }
    log.info("VpnManager:SetIptables", serverNetwork, localIp);

    const commands =[
      // delete this rule if it exists, logical opertion ensures correct execution
      wrapIptables(`sudo iptables -w -t nat -D POSTROUTING -s ${serverNetwork}/24 -o eth0 -j SNAT --to-source ${localIp}`),
      // insert back as top rule in table
      `sudo iptables -w -t nat -I POSTROUTING 1 -s ${serverNetwork}/24 -o eth0 -j SNAT --to-source ${localIp}`
    ];
    await iptable.run(commands);
  }

  async unsetIptables() {
    const serverNetwork = this.serverNetwork;
    let localIp = sysManager.myIp();
    if (this._currentLocalIp)
      localIp = this._currentLocalIp;
    if (!serverNetwork) {
      return;
    }
    log.info("VpnManager:UnsetIptables", serverNetwork, localIp);
    const commands = [
      wrapIptables(`sudo iptables -w -t nat -D POSTROUTING -s ${serverNetwork}/24 -o eth0 -j SNAT --to-source ${localIp}`),
    ];
    this._currentLocalIp = null;
    await iptable.run(commands);
  }

  async removeUpnpPortMapping(opts) {
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

  async configure(config, needRestart) {
    if (config) {
      if (config.serverNetwork) {
        this.serverNetwork = config.serverNetwork;
      }
      if (config.netmask) {
        this.netmask = config.netmask;
      }
      if (config.localPort) {
        this.localPort = config.localPort;
      }
      if (config.externalPort) {
        this.externalPort = config.externalPort;
      }
    }
    if (this.serverNetwork == null) {
      this.serverNetwork = this.generateNetwork();
    }
    if (this.netmask == null) {
      this.netmask = "255.255.255.0";
    }
    if (this.localPort == null) {
      this.localPort = "1194";
    }
    if (this.externalPort == null) {
      this.externalPort = this.localPort;
    }
    if (this.instanceName == null) {
      this.instanceName = "server";
    }
    if (needRestart === true) {
      this.needRestart = true;
    }
    var mydns = sysManager.myDNS()[0];
    if (mydns == null) {
      mydns = "8.8.8.8"; // use google DNS as default
    }
    const confGenLockFile = "/dev/shm/vpn_confgen_lock_file";
    const cmd = util.format("cd %s/vpn; flock -n %s -c 'sudo -E ./confgen.sh %s %s %s %s %s %s'; sync",
      fHome, confGenLockFile, this.instanceName, sysManager.myIp(), mydns, this.serverNetwork, this.netmask, this.localPort);
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
      externalPort: this.externalPort
    };
  }

  async stop() {
    try {
      if (this.refreshTask)
        clearInterval(this.refreshTask);
      await this.removeUpnpPortMapping({
        protocol: 'udp',
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
      portmapped: this.portmapped
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
        externalPort: this.localPort,
        portmapped: this.portmapped
      };
      // callback(null, this.portmapped, this.portmapped, this.serverNetwork, this.localPort);
    }

    if (this.instanceName == null) {
      log.error("Server instance is not installed yet.");
      return {
        state: false
      };
    }

    this.upnp.gw = sysManager.myGateway();

    if (!this.refreshTask) {
      this.refreshTask = setInterval(async () => {
        // extend upnp lease once every 10 minutes in case router flushes it unexpectedly
        await this.addUpnpPortMapping("udp", this.localPort, this.externalPort, "Firewalla OpenVPN").catch((err) => {
          log.error("Failed to set Upnp port mapping", err);
        });
      }, 600000);
    }

    await this.removeUpnpPortMapping({
      protocol: 'udp',
      private: this.localPort,
      public: this.externalPort
    }).catch((err)=> {
      log.error("Failed to remove Upnp port mapping", err);
    });
    this.portmapped = false;
    let op = "start";
    if (this.needRestart) {
      op = "restart";
      this.needRestart = false;
    }
    log.info("VpnManager:Start:" + this.instanceName);
    try {
      await execAsync(util.format("sudo systemctl %s openvpn@%s", op, this.instanceName));
      this.started = true;
      await this.setIptables();
      this.portmapped = await this.addUpnpPortMapping("udp", this.localPort, this.externalPort, "Firewalla OpenVPN").catch((err) => {
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
        portmapped: this.portmapped
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

  static getOvpnFile(clientname, password, regenerate, compressAlg, externalPort, callback) {
    let ovpn_file = util.format("%s/ovpns/%s.ovpn", process.env.HOME, clientname);
    let ovpn_password = util.format("%s/ovpns/%s.ovpn.password", process.env.HOME, clientname);
    if (compressAlg == null)
      compressAlg = "";

    log.info("Reading ovpn file", ovpn_file, ovpn_password, regenerate);

    fs.readFile(ovpn_file, 'utf8', (err, ovpn) => {
      if (ovpn != null && regenerate == false) {
        let password = fs.readFileSync(ovpn_password, 'utf8').trim();
        log.info("VPNManager:Found older ovpn file: " + ovpn_file);
        callback(null, ovpn, password);
        return;
      }

      let originalName = clientname;
      // Original name remains unchanged even if client name is trailed by random numbers.
      // So that client ovpn file name will remain unchanged while its content has been updated.
      // always randomize the name when creating
//      if (regenerate == true) {
      clientname = clientname + VpnManager.generatePassword(15);
//      }

      if (password == null) {
        password = VpnManager.generatePassword(5);
      }

      let ip = sysManager.myDDNS();
      if (ip == null) {
        ip = sysManager.publicIp;
      }

      var mydns = sysManager.myDNS()[0];
      if (mydns == null) {
        mydns = "8.8.8.8"; // use google DNS as default
      }

      const vpnLockFile = "/dev/shm/vpn_gen_lock_file";

      let cmd = util.format("cd %s/vpn; flock -n %s -c 'sudo -E ./ovpngen.sh %s %s %s %s %s %s'; sync",
        fHome, vpnLockFile, clientname, password, ip, externalPort, originalName, compressAlg);
      log.info("VPNManager:GEN", cmd);
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          log.error("VPNManager:GEN:Error", "Unable to ovpngen.sh", err);
        }
        fs.readFile(ovpn_file, 'utf8', (err, ovpn) => {
          if (callback) {
            callback(err, ovpn, password);
          }
        });
      });
    });
  }
}

module.exports = VpnManager;