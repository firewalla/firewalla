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

'use strict'

let instance = null;
const log = require('../../net2/logger.js')(__filename)

const f = require('../../net2/Firewalla.js')

const rclient = require('../../util/redis_manager.js').getRedisClient()
const sclient = require('../../util/redis_manager.js').getSubscriptionClient();
const sem = require('../../sensor/SensorEventManager.js').getInstance();

const SysManager = require('../../net2/SysManager')
const sysManager = new SysManager()

const HostTool = require('../../net2/HostTool.js');
const hostTool = new HostTool();
const ipTool = require('ip');

const ShieldManager = require('../../net2/ShieldManager.js');
let shieldManager = null;

const iptable = require("../../net2/Iptables.js");

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
//      toMAC: mac of the destination
//      toPort: ip port
//   ]
// } 
 
class PortForward {
  constructor() {
    if(!instance) {
      this.config = {maps:[]}
      sem.once('IPTABLES_READY', () => {
        if (f.isMain()) {
          let c = require('../../net2/MessageBus.js');
          this.channel = new c('debug');
          this.channel.subscribe("FeaturePolicy", "Extension:PortForwarding", null, (channel, type, ip, obj) => {
            if (type == "Extension:PortForwarding") {
              (async ()=>{
                if (obj!=null) {
                  if (obj.state == false) {
                    await this.removePort(obj);
                  } else {
                    await this.addPort(obj);
                  }
                  // TODO: config should be saved after rule successfully applied
                  await this.refreshConfig();
                }
              })();
            }
          });
  
          sclient.on("message", (channel, message) => {
            switch (channel) {
              case "System:IPChange":
                (async () => {
                  if (sysManager.myIp() !== this._selfIP) {
                    log.info(`Firewalla IP changed from ${this._selfIP} to ${sysManager.myIp()}, refresh all rules...`);
                    await iptable.portForwardFlushAsync();
                    await this.restore();
                    this._selfIP = sysManager.myIp();
                  }
                })().catch((err) => {
                  log.error("Failed to refresh port forward rules for System:IPChange", err);
                })
                break;
              default:
            }
          });
          sclient.subscribe("System:IPChange");
        }
      })    
      instance = this
    }

    return instance
  }

  async refreshConfig() {
    if (this.config == null || this.config.maps == null)
      return;
    const mapsCopy = JSON.parse(JSON.stringify(this.config.maps));
    const updatedMaps = [];
    for (let map of mapsCopy) {
      if (!map.toIP) {
        log.error("toIP is not defined: ", map);
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
            log.info("IP address has changed, add new rule: ", map);
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
    log.info("PortForwarder:Saving:",string);
    return rclient.setAsync(configKey, string)
  }

  async loadConfig() {
    let json = await rclient.getAsync(configKey)
    log.info("PortForwarder:Config:", json);
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
          (!map.dport || map.dport == "*" || _map.dport == map.dport) &&
          (!map.toPort || map.toPort == "*" || _map.toPort == map.toPort) &&
          (!map.protocol || map.protocol == "*" || _map.protocol == map.protocol) &&
          _map.toIP == map.toIP
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
          if (this.config.maps[old].state == true) {
            log.info("PORTMAP:addPort Duplicated MAP", map);
            return;
          } else {
            this.config.maps[old] = map;
          }
        } else {
          this.config.maps.push(map);
        }
      }

      if (!this._isSecondaryInterfaceIP(map.toIP)) {
        log.warn("IP is not in secondary network, port forward will not be applied: ", map);
        return;
      }
      
      log.info("PORTMAP: Add", map);
      if (!shieldManager)
        shieldManager = new ShieldManager();
      await shieldManager.addIncomingRule(map.protocol, map.toIP, map.dport)
      map.state = true;
      const dupMap = JSON.parse(JSON.stringify(map))
      dupMap.destIP = sysManager.myIp()
      await iptable.portforwardAsync(dupMap)
    } catch (err) {
      log.error("Failed to add port mapping:", err);
    }
  }

  // save config should follow this
  async removePort(map) {
    let old = this.find(map);
    while (old >= 0) {
      this.config.maps[old].state = false;
      const dupMap = JSON.parse(JSON.stringify(this.config.maps[old]))
      this.config.maps.splice(old, 1);

      log.info("PortForwarder:removePort Found MAP", dupMap);
      if (!shieldManager)
        shieldManager = new ShieldManager();
      await shieldManager.removeIncomingRule(dupMap.protocol, dupMap.toIP, dupMap.dport);

      // we call remove anyway ... even there is no entry
      dupMap.destIP = sysManager.myIp()
      await iptable.portforwardAsync(dupMap);

      old = this.find(map);
    }
  }

  async restore() {
    try {
      log.info("PortForwarder:ApplyConfig ...")
      if (this.config && this.config.maps) {
        for (let i in this.config.maps) {
          let map = this.config.maps[i];
          log.info("Restoring Map: ", map);
          await this.addPort(map, true)
        }
      }
    } catch (err) { };
  }

  async start() {
    log.info("PortForwarder:Starting PortForwarder ...")
    this._selfIP = sysManager.myIp();
    shieldManager = new ShieldManager();
  
    await this.loadConfig()
    await this.restore()
    await this.refreshConfig()
    if (f.isMain()) {
      setInterval(() => {
        this.refreshConfig();
      }, 60000); // refresh config once every minute
    }
  }

  async stop() {
    log.info("PortForwarder:Stopping PortForwarder ...")
    await this.saveConfig().catch((err) => {
    })
  }

  _isSecondaryInterfaceIP(ip) {
    const ip2 = sysManager.myIp2();
    const ipMask2 = sysManager.myIpMask2();
    
    if(ip && ip2 && ipMask2) {
      return ipTool.subnet(ip2, ipMask2).contains(ip);
    }
    return false;
  }
}

module.exports = PortForward;
