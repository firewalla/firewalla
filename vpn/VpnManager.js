/*    Copyright 2016-2025 Firewalla Inc.
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
const net = require('net')
const ipUtil = require('../util/IPUtil.js')
const mode = require('../net2/Mode.js');

const fireRouter = require('../net2/FireRouter.js')
const _ = require('lodash');

const fs = require('fs');
const fsp = fs.promises

const sem = require('../sensor/SensorEventManager.js').getInstance();
const util = require('util');
const execAsync = util.promisify(cp.exec);
const writeFileAsync = util.promisify(fs.writeFile);
const readFileAsync = util.promisify(fs.readFile);
const readdirAsync = util.promisify(fs.readdir);
const statAsync = util.promisify(fs.stat);
const {Address4, Address6} = require('ip-address');
const {BigInteger} = require('jsbn');
const {fileExist} = require('../util/util.js');

const pclient = require('../util/redis_manager.js').getPublishClient();

const UPNP = require('../extension/upnp/upnp.js');
const Message = require('../net2/Message.js');
const crypto = require('crypto');

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

  async setIp6tables() {
    const serverNetwork6 = this.serverNetwork6;
    if (!serverNetwork6) {
      return;
    }
    log.info("VpnManager:setIp6tables", serverNetwork6);
    // clean up ipv6
    await iptable.run(["sudo ip6tables -w -t nat -F FW_POSTROUTING_OPENVPN"]);
    if (platform.isFireRouterManaged()) {
      const wanNames = this.getEffectiveWANNames();
      const commands = wanNames.map((name) => `sudo ip6tables -w -t nat -I FW_POSTROUTING_OPENVPN -s ${serverNetwork6} -o ${name} -j MASQUERADE`);
      await iptable.run(commands);
    } else {
      const commands =[
        // delete this rule if it exists, logical opertion ensures correct execution
        wrapIptables(`sudo ip6tables -w -t nat -D FW_POSTROUTING -s ${serverNetwork6}/24 -j MASQUERADE`),
        // insert back as top rule in table
        `sudo ip6tables -w -t nat -I FW_POSTROUTING 1 -s ${serverNetwork6} -j MASQUERADE`
      ];
      await iptable.run(commands);
    }

    this._currentServerNetwork6 = serverNetwork6;

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

  async unsetIp6tables() {
    let serverNetwork6 = this.serverNetwork6;
    if (this._currentServerNetwork6)
      serverNetwork6 = this._currentServerNetwork6;
    if (!serverNetwork6) {
      return;
    }
    log.info("VpnManager:UnsetIp6tables", serverNetwork6);

    // clean up
    await iptable.run(["sudo ip6tables -w -t nat -F FW_POSTROUTING_OPENVPN"]);
    this._currentServerNetwork6 = null;
  }

  async removeUpnpPortMapping() {
    if (!sysManager.myDefaultWanIp() || !ipUtil.isPrivate(sysManager.myDefaultWanIp())) {
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
    if (!sysManager.myDefaultWanIp() || !ipUtil.isPrivate(sysManager.myDefaultWanIp())) {
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
    if (this.serverNetwork6 == null) {
      this.serverNetwork6 = this.generateLocalIpv6Network();
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
    var mydns6 = (sysManager.myResolver6("tun_fwvpn") && sysManager.myResolver6("tun_fwvpn")[0]) || sysManager.myDefaultDns6()[0];
    const myip  = ip.subnet(this.serverNetwork, this.netmask).firstAddress;
    this.ipv6Addr = this.firstIpv6Address(this.serverNetwork6);

    const vpnIntf = sysManager.getInterface("tun_fwvpn");
    // push vpn local IP as DNS option if resolver is from WAN, i.e. no dedicated DNS server specified on vpn network
    if (vpnIntf && vpnIntf.resolverFromWan) {
      mydns = myip;
      mydns6 = this.ipv6Addr;
    }
    if (mydns == null || mydns === "127.0.0.1") {
      mydns = "8.8.8.8"; // use google DNS as default
    }
    if (mydns6 == null || mydns6 === "::1") {
      mydns6 = "2001:4860:4860::8888"; // use google DNS as default
    }
    if (this.mydns !== mydns)
      this.needRestart = true;
    this.mydns = mydns;
    const confGenLockFile = "/dev/shm/vpn_confgen_lock_file";
    // sysManager.myIp() is not used in the below command
    const cmd = `cd ${fHome}/vpn; flock -n ${confGenLockFile} -c 'ENCRYPT=${platform.getDHKeySize()} sudo -E ./confgen.sh ${this.instanceName} ${this.listenIp} ${mydns} ${this.serverNetwork} ${this.netmask} ${this.localPort} ${this.protocol} ${mydns6} ${this.serverNetwork6}'; sync`
    log.info("VPNManager:CONFIGURE:cmd", cmd);
    await execAsync(cmd).catch((err) => {
      log.error("VPNManager:CONFIGURE:Error", "Unable to generate server config for " + this.instanceName, err);
      return null;
    });
      log.info("VPNManager:CONFIGURE:Done");
    return {
      serverNetwork: this.serverNetwork,
      netmask: this.netmask,
      serverNetwork6: this.serverNetwork6,
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
      Updated,2025-08-22 14:50:18
      Common Name,Real Address,Bytes Received,Bytes Sent,Connected Since
      fishboneVPN1,192.168.169.166:56390,32900,31202,2025-08-22 14:50:14
      ROUTING TABLE
      Virtual Address,Common Name,Real Address,Last Ref
      fd9b:7a55:a878:ae29::1000,fishboneVPN1,192.168.169.166:56390,2025-08-22 14:50:14
      10.119.105.6,fishboneVPN1,192.168.169.166:56390,2025-08-22 14:50:18
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
                    } else if (new Address6(values[j]).isValid()) {
                      if (!clientDesc.vAddr6)
                        clientDesc.vAddr6 = [values[j]];
                      else
                        clientDesc.vAddr6.push(values[j]);
                    }
                    clientDesc.vAddr = clientDesc.vAddr || [];
                    clientDesc.vAddr6 = clientDesc.vAddr6 || [];
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
                Array.prototype.push.apply(clientDesc.vAddr6, clientMap[key].vAddr6 || []);
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
      await this.unsetIp6tables();
    } catch (err) {
      log.error("Failed to stop OpenVPN", err);
    }
    return {
      state: false,
      serverNetwork: this.serverNetwork,
      netmask: this.netmask,
      serverNetwork6: this.serverNetwork6,
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
        serverNetwork6: this.serverNetwork6,
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
      await this.setIp6tables();
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
        serverNetwork6: this.serverNetwork6,
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
        serverNetwork6: this.serverNetwork6,
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
    let stop = false;
    while (!stop) {
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

  generateLocalIpv6Network() {
    /**
     * 7 bits | 1 | 40 bits   | 16 bits
     * --------------------------------
     * prefix | L | Global ID | Subnet ID
     */
    // generate global ID
    // step1, obtain current time in NTP format
    const ntpEpoch = BigInt(Date.now());
    const ntpTime = Buffer.alloc(8);
    ntpTime.writeBigUInt64BE(ntpEpoch);
    //step2, Obtain an EUI-64 identifier from the system 
    const randomBytes = crypto.randomBytes(8);
    //step3, concatenate the NTP time and EUI-64 identifier
    const data = Buffer.concat([ntpTime, randomBytes]);
    //step4, Compute an SHA-1 digest on the key
    const sha1 = crypto.createHash('sha1').update(data).digest();
    //step5, take the first 40 bits of the SHA-1 digest
    const gid = sha1.subarray(0, 5);

    let subnet = null;
    let stop = false;
    while (!stop) {
      // generate subnet ID
      const subnetId = crypto.randomBytes(2);

      // generate local IPv6 network
      const h1 = (0xfd00 | gid[0]).toString(16).padStart(4, '0');
      const h2 = ((gid[1] << 8) | gid[2]).toString(16).padStart(4, '0');
      const h3 = ((gid[3] << 8) | gid[4]).toString(16).padStart(4, '0');
      const h4 = ((subnetId[0] << 8) | subnetId[1]).toString(16).padStart(4, '0');

      subnet =  `${h1}:${h2}:${h3}:${h4}::/64`;
      if (!sysManager.inMySubnet6(subnet)) {
        stop = true;
      }
    }
    return subnet;
  }

  firstIpv6Address(subnet) {
    const addr = new Address6(subnet);
    if (!addr.isValid()) {
      log.error(`VPNManager:CONFIGURE:Invalid IPv6 address: ${subnet}`);
      return null;
    }
    let first = addr.startAddress().bigInteger().add(BigInteger.ONE);
    return Address6.fromBigInteger(first).correctForm();
  }

  static getSettingsDirectoryPath(commonName) {
    return `${process.env.HOME}/ovpns/${commonName}`;
  }

  static async configureClient(commonName, settings) {
    settings = settings || {};
    const configRC = [];
    const configCCD = [];
    /* comp-lzo is deprecated
    configCCD.push("comp-lzo no"); // disable compression in client-config-dir
    configCCD.push("push \"comp-lzo no\"");
    */
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
            if (!net.isIPv4(ipAddr))
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
    const allSettings = {};
    const filenames = await readdirAsync(settingsDirectory, 'utf8');
    await Promise.all(filenames.map(async (filename) => {
      const fileEntry = await statAsync(`${settingsDirectory}/${filename}`);
      if (fileEntry.isDirectory()) {
        // directory contains .json and .rc file
        const settingsFilePath = `${VpnManager.getSettingsDirectoryPath(filename)}/${filename}.json`;
        const settings = await readFileAsync(settingsFilePath, 'utf8').then((content) => {
          return JSON.parse(content)
        }).catch((err) => {
          log.error("Failed to read settings from " + settingsFilePath, err);
          return null;
        });
        if (settings)
          allSettings[filename] = settings;
      }
    }));
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
  }

  static async getOvpnFile(commonName, password, regenerate, externalPort, protocol = null, ddnsEnabled) {
    let ovpn_file = util.format("%s/ovpns/%s.ovpn", process.env.HOME, commonName);
    let ovpn_password = util.format("%s/ovpns/%s.ovpn.password", process.env.HOME, commonName);
    protocol = protocol || platform.getVPNServerDefaultProtocol();

    let ip = sysManager.myDDNS();
    if (ip == null || !ddnsEnabled) {
      ip = sysManager.publicIp;
    }

    log.info("Reading ovpn file", ovpn_file, ovpn_password, regenerate);

    const ovpn = await fsp.readFile(ovpn_file, 'utf8').catch(() => null)
    if (ovpn != null && regenerate == false) {
      let password = (await fsp.readFile(ovpn_password, 'utf8').catch(()=> "")).trim();
      log.info("VPNManager:Found older ovpn file: " + ovpn_file);
      let profile = ovpn.replace(/remote\s+[\S]+\s+\d+/g, `remote ${ip} ${externalPort}`);
      profile = profile.replace(/proto\s+\w+/g, `proto ${protocol}`);
      const timestamp = await VpnManager.getVpnConfigureTimestamp(commonName);
      return { ovpnfile: profile, password, timestamp }
    }

    if (password == null) {
      password = VpnManager.generatePassword(5);
    }

    const vpnLockFile = "/dev/shm/vpn_gen_lock_file";

    let cmd = util.format("cd %s/vpn; flock -n %s -c 'sudo -E ./ovpngen.sh %s %s %s %s %s'; sync",
      fHome, vpnLockFile, commonName, password, ip, externalPort, protocol);
    await execAsync(cmd).catch(err => {
      log.error("VPNManager:GEN:Error", "Unable to ovpngen.sh", err);
    })
    const event = {
      type: Message.MSG_OVPN_PROFILES_UPDATED,
      cn: commonName
    };
    sem.sendEventToAll(event);
    const ovpnfile = await fsp.readFile(ovpn_file, 'utf8')
    const timestamp = await VpnManager.getVpnConfigureTimestamp(commonName);
    return { ovpnfile, password, timestamp}
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
