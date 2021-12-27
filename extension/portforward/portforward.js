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

'use strict'

let instance = null;
const log = require('../../net2/logger.js')(__filename)

const f = require('../../net2/Firewalla.js')

const rclient = require('../../util/redis_manager.js').getRedisClient()
const sem = require('../../sensor/SensorEventManager.js').getInstance();

const sysManager = require('../../net2/SysManager')

const HostTool = require('../../net2/HostTool.js');
const hostTool = new HostTool();
const exec = require('child-process-promise').exec;

const iptable = require("../../net2/Iptables.js");
const Message = require('../../net2/Message.js');
const pl = require('../../platform/PlatformLoader.js');
const platform = pl.getPlatform();

// Configurations
const configKey = 'extension.portforward.config'

// Configure Port Forwarding
// Example:
// {
//  maps:
//   [
//      description: "string"
//      protocol: tcp/udp
//      dport: integer
//      toIP: ip address
//      toMac: mac of the destination
//      toPort: ip port
//      enabled: true/false, activate/deactivate port forward, default to true
//   ]
// }

// only supports IPv4 for now
class PortForward {
  constructor() {
    if(!instance) {
      this.config = {maps:[]}
      sem.once('IPTABLES_READY', () => {
        if (f.isMain()) {
          let c = require('../../net2/MessageBus.js');
          this.channel = new c('debug');
          this.channel.subscribe("FeaturePolicy", "Extension:PortForwarding", null, async (channel, type, ip, obj) => {
            if (type != "Extension:PortForwarding") return

            try {
              if (obj != null) {
                if (!obj.hasOwnProperty("enabled"))
                  obj.enabled = true;
                if (obj.state == false) {
                  await this.removePort(obj);
                } else {
                  if (obj.enabled === false)
                    await this.removePort(obj);
                  await this.addPort(obj);
                }
                // TODO: config should be saved after rule successfully applied
                await this.saveConfig();
              }
            } catch(err) {
              log.error('Error applying port-forward', obj, err)
            }
          });

          sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, async () => {
            if (!this._started)
              return;
            try {
              const myWanIps = sysManager.myWanIps().v4
              if (this._wanIPs && (myWanIps.length !== this._wanIPs.length || myWanIps.some(i => !this._wanIPs.includes(i)))) {
                this._wanIPs = myWanIps;
                if (platform.isOverlayNetworkAvailable()) {
                  const primaryInterface = sysManager.getDefaultWanInterface();
                  if (primaryInterface) {
                    const overlayInterface = sysManager.getInterface(primaryInterface.name + ":0");
                    const overlayIP = overlayInterface && overlayInterface.ip_address;
                    if (overlayIP && sysManager.inMySubnets4(overlayIP, primaryInterface.name)) {
                      if (!this._wanIPs.includes(overlayIP))
                        this._wanIPs.push(overlayIP);
                    }
                  }
                }
                await this.updateExtIPChain(this._wanIPs);
              }
              await this.loadConfig();
              await this.restore();
              await this.refreshConfig();
            } catch(err) {
              log.error("Failed to refresh port forward rules", err);
            }
          })
        }
      })
      instance = this;
    }

    return instance;
  }

  async updateExtIPChain(extIPs) {
    const cmd = iptable.wrapIptables(`sudo iptables -w -t nat -F FW_PREROUTING_EXT_IP`);
    await exec(cmd).catch((err) => {
      log.error(`Failed to flush FW_PREROUTING_EXT_IP`, err.message);
    });
    for (const extIP of extIPs) {
      const cmd = iptable.wrapIptables(`sudo iptables -w -t nat -A FW_PREROUTING_EXT_IP -d ${extIP} -j FW_PREROUTING_PORT_FORWARD`);
      await exec(cmd).catch((err) => {
        log.error(`Failed to update FW_PREROUTING_EXT_IP with command: ${cmd}`, err.message);
      });
    }
  }

  async refreshConfig() {
    if (this.config == null || this.config.maps == null)
      return;
    const mapsCopy = JSON.parse(JSON.stringify(this.config.maps));
    const updatedMaps = [];
    for (let map of mapsCopy) {
      if (!map.toIP && !map.toMac) {
        log.error("Neither toMac nor toIP is defined: ", map);
        await this.removePort(map);
        continue;
      }
      if (!map.toMac) {
        // need to convert toIP to mac address of the internal host. Legacy port forwarding rules only contain IP address.
        const mac = await hostTool.getMacByIP(map.toIP);
        if (!mac) {
          log.error("No corresponding MAC address found: ", map);
          await this.removePort(map);
          continue;
        }
        const macEntry = await hostTool.getMACEntry(mac);
        if (!macEntry) {
          log.error("MAC entry is not found: ", map);
          await this.removePort(map);
          continue;
        }
        const ipv4Addr = macEntry.ipv4Addr;
        if (!ipv4Addr || ipv4Addr !== map.toIP) {
          // the toIP is already taken over by another device
          log.error("IP address is already taken by other device: ", map);
          await this.removePort(map);
          continue;
        }
        map.toMac = mac;
        updatedMaps.push(map);
      } else {
        // update IP of the device from host:mac:* entries
        const macEntry = await hostTool.getMACEntry(map.toMac);
        if (!macEntry) {
          log.error("MAC entry is not found: ", map);
          await this.removePort(map);
          continue;
        }
        const ipv4Addr = macEntry.ipv4Addr;
        if (ipv4Addr !== map.toIP) {
          // remove old port forwarding rule with legacy IP address
          log.info("IP address has changed, remove old rule: ", map);
          await this.removePort(map);
          if (ipv4Addr) {
            // add new port forwarding rule with updated IP address
            map.toIP = ipv4Addr;
            map.active = true;
            log.info("IP address has changed, add new rule: ", map);
            await this.addPort(map);
          } else {
            map.toIP = null;
            map.active = false;
            log.info("IP address is not available, deactivating rule: ", map);
            await this.addPort(map);
          }
        }
        map.toIP = ipv4Addr; // ensure the latest ipv4 address is synced no matter if it is changed
        updatedMaps.push(map);
      }
    }
    this.config.maps = updatedMaps;
    await this.saveConfig();
  }

  async saveConfig() {
    if (this.config == null) {
        return;
    }
    let string = JSON.stringify(this.config)
    log.debug("PortForwarder:Saving:",string);
    return rclient.setAsync(configKey, string)
  }

  async loadConfig() {
    let json = await rclient.getAsync(configKey)
    log.debug("PortForwarder:Config:", json);
    if (json) {
      try {
        let config = JSON.parse(json)
        this.config = config
      } catch (err) {
        log.error("PortForwarder:Failed to parse config:", json, err);
        this.config = { maps: [] };
      }
    } else {
      log.info("PortForwarder:EmptyConfig");
      this.config = { maps: [] };
    }
  }

  setConfig(config) {
    this.config = config
    return this.saveConfig(this.config)
  }

  // return -1 if not found
  //        index if found
  //        undefined, null, 0, false, '*' will be recognized as wildcards

  find(map) {
    if (this.config == null || this.config.maps == null) {
      return -1;
    } else {
      for (let i in this.config.maps) {
        let _map = this.config.maps[i];
        if (
          (!map.extIP || map.extIP == "*" || _map.extIP == map.extIP) && 
          (!map.dport || map.dport == "*" || _map.dport == map.dport) &&
          (!map.toPort || map.toPort == "*" || _map.toPort == map.toPort) &&
          (!map.protocol || map.protocol == "*" || _map.protocol == map.protocol) &&
          (!map.toIP && map.toMac && _map.toMac == map.toMac || map.toIP && _map.toIP == map.toIP) &&
          (map._type == "*" || (_map._type || "port_forward") === (map._type || "port_forward"))
        ) {
          return i;
        }
      }
    }
    return -1;
  }

  // save config should follow this
  async addPort(map, init) {
    try {
      if (init == false || init == null) {
        let old = this.find(map);
        if (old >= 0) {
          if (this.config.maps[old].enabled === map.enabled) {
            log.info("PORTMAP:addPort Duplicated MAP", map);
            return;
          } else {
            this.config.maps[old] = map;
          }
        } else {
          this.config.maps.push(map);
        }
      }

      if (map.active === false) {
        log.info("Port forward is not active now", map);
        return;
      }

      if (map.enabled === false) {
        log.info("Port forward is disabled now", map);
        return;
      }

      if (!this._isLANInterfaceIP(map.toIP)) {
        log.warn("IP is not in secondary network, port forward will not be applied: ", map);
        return;
      }

      log.info(`Add port forward`, map);
      map.state = true;
      map.active = true;
      map.enabled = true;
      const dupMap = JSON.parse(JSON.stringify(map));
      await iptable.portforwardAsync(dupMap);
    } catch (err) {
      log.error("Failed to add port mapping:", err);
    }
  }

  // save config should follow this
  async removePort(map) {
    let old = this.find(map);
    while (old >= 0) {
      this.config.maps[old].state = false;
      if (this.config.maps[old].active !== false && this.config.maps[old].enabled !== false) {
        log.info(`Remove port forward`, this.config.maps[old]);
        const dupMap = JSON.parse(JSON.stringify(this.config.maps[old]));
        await iptable.portforwardAsync(dupMap);
      }

      this.config.maps.splice(old, 1);
      old = this.find(map);
    }
  }

  async restore() {
    try {
      log.info("PortForwarder:ApplyConfig ...")
      if (this.config && this.config.maps) {
        for (let i in this.config.maps) {
          let map = this.config.maps[i];
          await this.addPort(map, true)
        }
      }
    } catch (err) { }
  }

  async start() {
    log.info("PortForwarder:Starting PortForwarder ...")
    this._wanIPs = sysManager.myWanIps().v4;
    if (platform.isOverlayNetworkAvailable()) {
      const primaryInterface = sysManager.getDefaultWanInterface();
      if (primaryInterface) {
        const overlayInterface = sysManager.getInterface(primaryInterface.name + ":0");
        const overlayIP = overlayInterface && overlayInterface.ip_address;
        if (overlayIP && sysManager.inMySubnets4(overlayIP, primaryInterface.name)) {
          if (!this._wanIPs.includes(overlayIP))
            this._wanIPs.push(overlayIP);
        }
      }
    }
    await this.updateExtIPChain(this._wanIPs);
    await this.loadConfig()
    await this.restore()
    await this.refreshConfig()
    if (f.isMain()) {
      setInterval(() => {
        this.refreshConfig();
      }, 60000); // refresh config once every minute
    }
    this._started = true;
  }

  async stop() {
    log.info("PortForwarder:Stopping PortForwarder ...")
    await this.saveConfig().catch(() => { })
  }

  _isLANInterfaceIP(ip) {
    const iface = sysManager.getInterfaceViaIP(ip);
    if (!iface || !iface.name)
      return false;
    if (iface.type === "lan")
      return true;
    if (platform.isOverlayNetworkAvailable()) {
      // on red/blue/navy, if overlay and primary network are in the same subnet, getInterfaceViaIP4 will return primary network, which is LAN
      if (sysManager.inMySubnets4(ip, `${iface.name}:0`))
        return true;
    }
    return false;
  }
}

module.exports = PortForward;
