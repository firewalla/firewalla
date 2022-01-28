/*    Copyright 2016-2021 Firewalla Inc.
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

const fireRouter = require('../net2/FireRouter.js')
const _ = require('lodash');

const fs = require('fs');

const sem = require('../sensor/SensorEventManager.js').getInstance();
const util = require('util');
const Promise = require('bluebird');
const execAsync = util.promisify(cp.exec);
const writeFileAsync = util.promisify(fs.writeFile);
const readFileAsync = util.promisify(fs.readFile);
const readdirAsync = util.promisify(fs.readdir);
const statAsync = util.promisify(fs.stat);
const {Address4} = require('ip-address');
const {BigInteger} = require('jsbn');

const pclient = require('../util/redis_manager.js').getPublishClient();

const UPNP = require('../extension/upnp/upnp.js');
const Message = require('../net2/Message.js');

const moment = require('moment');

const INSTANCE_NAME = "server";

class VpnManager {
  constructor() {
    if (instance == null) {
      this.upnp = new UPNP();
      if (firewalla.isMain()) {
        sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, async () => {
          this.scheduleReload();
        });
      }
      instance = this;
      this.instanceName = INSTANCE_NAME; // defautl value
    }
    return instance;
  }

  scheduleReload() {
    if (this.reloadTask)
      clearTimeout(this.reloadTask);
    this.reloadTask = setTimeout(async () => {
      try {
        if (!this.started)
          return;
        // this.configure() with out arguments will leave the current config unchanged
        await this.configure().then(() => this.start()).catch((err) => {
          log.error("Failed to reconfigure and start VPN server", err.message);
        });
        await this.setIptables();
        // update UPnP port mapping
        await this.removeUpnpPortMapping().catch((err) => {});
        this.portmapped = await this.addUpnpPortMapping(this.protocol, this.localPort, this.externalPort, "Firewalla VPN")
        await this.updateOverlayNetworkDNAT().catch((err) => {
          log.error("Failed to update overlay network DNAT", err.message);
        });
        await this.updateMultiWanDNAT().catch((err) => {
          log.error("Failed to update multi WAN DNAT", err.message);
        });
      } catch(err) {
        log.error("Failed to set Upnp port mapping", err);
      }
    }, 15000);
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
        let install2_cmd = `cd ${fHome}/vpn; flock -n ${installLockFile} -c 'ENCRYPT=${platform.getDHKeySize()} sudo -E ./install2.sh ${instance}'; sync`;
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

  async updateMultiWanDNAT() {
    if (!platform.isFireRouterManaged())
      return;
    const primaryIp = sysManager.myDefaultWanIp();
    const allWanIps = sysManager.myWanIps().v4;
    if (!primaryIp || !allWanIps || allWanIps.length === 0)
      return;
    const localPort = this.localPort;
    const protocol = this.protocol;
    const commands = [];
    commands.push(wrapIptables(`sudo iptables -w -t nat -F FW_PREROUTING_VPN_OVERLAY`));
    for (const wanIp of allWanIps) {
      if (wanIp !== primaryIp)
        commands.push(wrapIptables(`sudo iptables -w -t nat -A FW_PREROUTING_VPN_OVERLAY -d ${wanIp} -p ${protocol} --dport ${localPort} -j DNAT --to-destination ${primaryIp}:${localPort}`));
    }
    await iptable.run(commands);
  }

  async updateOverlayNetworkDNAT() {
    if (!platform.isOverlayNetworkAvailable())
      return;
    const overlayIp = sysManager.myIp2();
    const primaryIp = sysManager.myDefaultWanIp();
    const localPort = this.localPort;
    const protocol = this.protocol;
    if (overlayIp === this._dnatOverlayIp && primaryIp === this._dnatPrimaryIp && localPort === this._dnatLocalPort && protocol === this._dnatProtocol)
      return;
    const commands = [];
    if (this._dnatOverlayIp && this._dnatPrimaryIp && this._dnatLocalPort && this._dnatProtocol)
      commands.push(wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_VPN_OVERLAY -d ${this._dnatOverlayIp} -p ${this._dnatProtocol} --dport ${this._dnatLocalPort} -j DNAT --to-destination ${this._dnatPrimaryIp}:${this._dnatLocalPort}`));
    const cidr1 = ip.cidrSubnet(sysManager.mySubnet());
    const cidr2 = ip.cidrSubnet(sysManager.mySubnet2());
    if (cidr1.networkAddress === cidr2.networkAddress && cidr1.subnetMask === cidr2.subnetMask) {
      commands.push(wrapIptables(`sudo iptables -w -t nat -A FW_PREROUTING_VPN_OVERLAY -d ${overlayIp} -p ${protocol} --dport ${localPort} -j DNAT --to-destination ${primaryIp}:${localPort}`));
      this._dnatOverlayIp = overlayIp;
      this._dnatPrimaryIp = primaryIp;
      this._dnatLocalPort = localPort;
      this._dnatProtocol = protocol;
    }
    if (commands.length > 0)
      await iptable.run(commands);
  }

  getEffectiveWANNames() {
    let wanNames = fireRouter.getWanIntfNames();
    if(!_.isEmpty(this.noSNATS)) {
      wanNames = wanNames.filter((n) => !this.noSNATS.includes(n));
    }
    return wanNames;
  }

  async setIptables() {
    const serverNetwork = this.serverNetwork;
    if (!serverNetwork) {
      return;
    }
    log.info("VpnManager:SetIptables", serverNetwork);

    // clean up
    await iptable.run(["sudo iptables -w -t nat -F FW_POSTROUTING_OPENVPN"]);
    
    if (platform.isFireRouterManaged()) {
      const wanNames = this.getEffectiveWANNames();
      const commands = wanNames.map((name) => `sudo iptables -w -t nat -I FW_POSTROUTING_OPENVPN -s ${serverNetwork}/24 -o ${name} -j MASQUERADE`);
      await iptable.run(commands);
    } else {
      const commands =[
        // delete this rule if it exists, logical opertion ensures correct execution
        wrapIptables(`sudo iptables -w -t nat -D FW_POSTROUTING -s ${serverNetwork}/24 -j MASQUERADE`),
        // insert back as top rule in table
        `sudo iptables -w -t nat -I FW_POSTROUTING 1 -s ${serverNetwork}/24 -j MASQUERADE`
      ];
      await iptable.run(commands);
    }

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

    // clean up
    await iptable.run(["sudo iptables -w -t nat -F FW_POSTROUTING_OPENVPN"]);
    this._currentServerNetwork = null;
  }

  async removeUpnpPortMapping() {
    if (!sysManager.myDefaultWanIp() || !ip.isPrivate(sysManager.myDefaultWanIp())) {
      log.info(`Defautl WAN IP ${sysManager.myDefaultWanIp()} is not a private IP, no need to remove upnp port mapping`);
      return false;
    }
    if (await mode.isRouterModeOn()) {
      log.info(`VPN server UPnP port mapping is not used in router mode`);
      return false;
    }
    const protocol = this._mappedProtocol || this.protocol;
    const localPort = this._mappedLocalPort || this.localPort;
    const externalPort = this._mappedExternalPort || this.externalPort;
    log.info(`Remove UPNP port mapping for VPN server, protocol ${protocol}, local port ${localPort}, external port ${externalPort}`);
    let timeoutExecuted = false;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        timeoutExecuted = true;
        log.error("Failed to remove upnp port mapping due to timeout");
        resolve(false);
      }, 10000);
      this.upnp.removePortMapping(protocol, localPort, externalPort, (err) => {
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
    if (await mode.isRouterModeOn()) {
      log.info(`VPN server UPnP port mapping is not used in router mode`);
      return false;
    }
    this._mappedProtocol = protocol;
    this._mappedLocalPort = localPort;
    this._mappedExternalPort = externalPort;
    log.info(`Add UPNP port mapping for VPN server, protocol ${protocol}, local port ${localPort}, external port ${externalPort}`);
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
        if (this.localPort && this.localPort !== config.localPort) {
          this.needRestart = true;
          this.localPortOrProtocolChanged = true;
        }
        this.localPort = config.localPort;
      }
      if (config.externalPort) {
        if (this.externalPort && this.externalPort !== config.externalPort)
          this.needRestart = true;
        this.externalPort = config.externalPort;
      }
      if (config.protocol) {
        if (this.protocol && this.protocol !== config.protocol) {
          this.needRestart = true;
          this.localPortOrProtocolChanged = true;
        }
        this.protocol = config.protocol;
      }
      if (config.noSNAT) {
        try {
          this.noSNATS = config.noSNAT.split(",");
        } catch(err) {
          log.error("Failed to parse noSNAT field, err:", err);
        }
      }
    }
    if (this.listenIp !== sysManager.myDefaultWanIp()) {
      this.needRestart = true;
      this.listenIp = sysManager.myDefaultWanIp();
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
      this.instanceName = INSTANCE_NAME;
      this.needRestart = true;
    }
    var mydns = (sysManager.myResolver("tun_fwvpn") && sysManager.myResolver("tun_fwvpn")[0]) || sysManager.myDefaultDns()[0];
    if (mydns == null || mydns === "127.0.0.1") {
      mydns = "8.8.8.8"; // use google DNS as default
    }
    const confGenLockFile = "/dev/shm/vpn_confgen_lock_file";
    // sysManager.myIp() is not used in the below command
    const cmd = `cd ${fHome}/vpn; flock -n ${confGenLockFile} -c 'ENCRYPT=${platform.getDHKeySize()} sudo -E ./confgen.sh ${this.instanceName} ${this.listenIp} ${mydns} ${this.serverNetwork} ${this.netmask} ${this.localPort} ${this.protocol}'; sync`
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
      cmd = `echo "status" | nc -w 5 -q 0 localhost 5194 | tail -n +2`;
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
                    clientDesc.rxBytes = !isNaN(values[j]) && Number(values[j]) || 0;
                    break;
                  case "Bytes Sent":
                    clientDesc.txBytes = !isNaN(values[j]) && Number(values[j]) || 0;
                    break;
                  case "Connected Since":
                    clientDesc.since = Math.floor(new Date(values[j]).getTime() / 1000);
                    break;
                  default:
                }
              }
              // "Real Address" column will only contain IP address if multihome is used in ovpn file, otherwise it will contain IP and port
              // Therefore need to include common name into key in case different common names come from the same IP address
              const key =`${clientDesc.cn}::${clientDesc.addr}`;
              if (clientMap[key]) {
                clientMap[key] = Object.assign({}, clientMap[key], clientDesc);
              } else {
                clientMap[key] = clientDesc;
              }
              break;
            }
            case "ROUTING TABLE": {
              const values = line.split(",");
              const clientDesc = {};
              for (let j in colNames) {
                switch (colNames[j]) {
                  case "Virtual Address":
                    if (new Address4(values[j]).isValid()) {
                      if (!clientDesc.vAddr)
                        clientDesc.vAddr = [values[j]];
                      else
                        clientDesc.vAddr.push(values[j]);
                    }
                    clientDesc.vAddr = clientDesc.vAddr || [];
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
              const key =`${clientDesc.cn}::${clientDesc.addr}`;
              if (clientMap[key]) {
                Array.prototype.push.apply(clientDesc.vAddr, clientMap[key].vAddr || []);
                clientMap[key] = Object.assign({}, clientMap[key], clientDesc);
              } else {
                clientMap[key] = clientDesc;
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
      await this.removeUpnpPortMapping();
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

    await this.removeUpnpPortMapping().catch((err)=> {
      log.error("Failed to remove Upnp port mapping", err.message);
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
      if(this.localPortOrProtocolChanged) {
        // no need to await this
        platform.onVPNPortProtocolChanged(); 
        this.localPortOrProtocolChanged = false;
      }
      this.started = true;
      await this.setIptables();
      this.portmapped = await this.addUpnpPortMapping(this.protocol, this.localPort, this.externalPort, "Firewalla VPN").catch((err) => {
        log.error("Failed to set Upnp port mapping", err);
        return false;
      });
      await this.updateOverlayNetworkDNAT().catch((err) => {
        log.error("Failed to update overlay network DNAT", err.message);
      });
      await this.updateMultiWanDNAT().catch((err) => {
        log.error("Failed to update multi WAN DNAT", err.message);
      });
      log.info("VpnManager:UPNP:SetDone", this.portmapped);
      const vpnSubnet = ip.subnet(this.serverNetwork, this.netmask);
      pclient.publishAsync("System:VPNSubnetChanged", this.serverNetwork + "/" + vpnSubnet.subnetMaskLength);
      log.info("apply profile to optimize network performance");
      platform.applyProfile();
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
    const ipRangeRandomMap = {
      "10.0.0.0/8": 16,
      "172.16.0.0/12": 12,
      "192.168.0.0/16": 8
    };
    let index = 0;
    while (true) {
      index = index % 3;
      const startAddress = Object.keys(ipRangeRandomMap)[index]
      const randomBits = ipRangeRandomMap[startAddress];
      const randomOffsets = Math.floor(Math.random() * Math.pow(2, randomBits)) * 256; // align with 8-bit
      const subnet = Address4.fromBigInteger(new Address4(startAddress).bigInteger().add(new BigInteger(randomOffsets.toString()))).correctForm();
      if (!sysManager.inMySubnets4(subnet))
        return subnet;
      else
        index++;
    }
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
          for (let clientSubnet of value) {
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
            // check if there is conflict between client subnets and Firewalla's subnets
            const conflictIface = sysManager.getLogicInterfaces().find((iface) => {
              const mySubnetCidr = iface.subnet && ip.cidrSubnet(iface.subnet);
              return mySubnetCidr && (mySubnetCidr.contains(clientSubnetCidr.firstAddress) || clientSubnetCidr.contains(mySubnetCidr.firstAddress)) || false;
            });
            if (conflictIface) {
              log.error(`Client subnet ${clientSubnetCidr} conflicts with server's interface ${conflictIface.name} ${conflictIface.subnet}`)
            } else {
              if (!clientSubnets.includes(`${clientSubnetCidr.networkAddress}/${clientSubnetCidr.subnetMaskLength}`)) {
                // add iroute to client config file
                configCCD.push(`iroute ${clientSubnetCidr.networkAddress} ${clientSubnetCidr.subnetMask}`);
                clientSubnets.push(`${clientSubnetCidr.networkAddress}/${clientSubnetCidr.subnetMaskLength}`);
              }
            }
          }
          configRC.push(`CLIENT_SUBNETS="${clientSubnets.join(',')}"`);
          break;
        default:
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
    const cmd = util.format("cd %s/vpn; flock -n %s -c 'sudo -E ./ovpnrevoke.sh %s %s; sync'", fHome, vpnLockFile, commonName, INSTANCE_NAME);
    log.info("VPNManager:Revoke", cmd);
    await execAsync(cmd).catch((err) => {
      log.error("Failed to revoke VPN profile " + commonName, err);
    });
    const event = {
      type: Message.MSG_OVPN_PROFILES_UPDATED,
      cn: commonName
    };
    sem.sendEventToAll(event);
    sem.emitLocalEvent(event);
  }

  static getOvpnFile(commonName, password, regenerate, externalPort, protocol = null, callback) {
    let ovpn_file = util.format("%s/ovpns/%s.ovpn", process.env.HOME, commonName);
    let ovpn_password = util.format("%s/ovpns/%s.ovpn.password", process.env.HOME, commonName);
    protocol = protocol || platform.getVPNServerDefaultProtocol();

    let ip = sysManager.myDDNS();
    if (ip == null) {
      ip = sysManager.publicIp;
    }

    log.info("Reading ovpn file", ovpn_file, ovpn_password, regenerate);

    fs.readFile(ovpn_file, 'utf8', (err, ovpn) => {
      if (ovpn != null && regenerate == false) {
        let password = fs.readFileSync(ovpn_password, 'utf8').trim();
        log.info("VPNManager:Found older ovpn file: " + ovpn_file);
        let profile = ovpn.replace(/remote\s+[\S]+\s+\d+/g, `remote ${ip} ${externalPort}`);
        profile = profile.replace(/proto\s+\w+/g, `proto ${protocol}`);
        (async () => {
          const timestamp = await VpnManager.getVpnConfigureTimestamp(commonName);
          callback(null, profile, password, timestamp);
        })();
        return;
      }

      if (password == null) {
        password = VpnManager.generatePassword(5);
      }

      const vpnLockFile = "/dev/shm/vpn_gen_lock_file";

      let cmd = util.format("cd %s/vpn; flock -n %s -c 'sudo -E ./ovpngen.sh %s %s %s %s %s'; sync",
        fHome, vpnLockFile, commonName, password, ip, externalPort, protocol);
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          log.error("VPNManager:GEN:Error", "Unable to ovpngen.sh", err);
        }
        const event = {
          type: Message.MSG_OVPN_PROFILES_UPDATED,
          cn: commonName
        };
        sem.sendEventToAll(event);
        sem.emitLocalEvent(event);
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


    try {

      const cmd = `sudo cat ${platform.openvpnFolder()}/easy-rsa/keys/index.txt | grep ${commonName}`;
      const result = await execAsync(cmd);
      if (result.stderr !== "") {
        log.error("Failed to read file.", result.stderr);
        return null;
      }

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
