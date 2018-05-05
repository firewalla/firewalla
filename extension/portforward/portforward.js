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
const fHome = f.getFirewallaHome()

const fConfig = require('../../net2/config.js').getConfig()

const rclient = require('../../util/redis_manager.js').getRedisClient()

const Promise = require('bluebird')

const async = require('asyncawait/async')
const await = require('asyncawait/await')

const SysManager = require('../../net2/SysManager')
const sysManager = new SysManager()

const rp = require('request-promise')

const exec = require('child-process-promise').exec

const fs = require('fs')
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
      let c = require('../../net2/MessageBus.js');
      this.channel = new c('debug');
      this.channel.subscribe("FeaturePolicy", "Extension:PortForwarding", null, (channel, type, ip, obj) => {
        if (type == "Extension:PortForwarding") {
          async(()=>{
            if (obj!=null) {
              if (obj.state == false) {
                await (this.removePort(obj));
              } else {
                await (this.addPort(obj));
              }
              await (this.saveConfig());
            }         
          })();
        } else {
          
        } 
      });

      instance = this      
    }

    return instance
  }

  saveConfig() {
    if (this.config == null) {
        return;
    }
    let string = JSON.stringify(this.config)
    log.info("PortForwarder:Saving:",string);
    return rclient.setAsync(configKey, string)
  }

  loadConfig() {
    return async(() => {
      let json = await (rclient.getAsync(configKey))
      log.info("PortForwarder:Config:",json);
      if(json) {
        try {
          let config = JSON.parse(json)
          this.config = config
        } catch(err) {
          log.error("PortForwarder:Failed to parse config:", json, err, {})
          this.config = {maps:[]};
        }
      } else {
        log.info("PortForwarder:EmptyConfig");
        this.config = {maps:[]};
      }
    })()
  }

  setConfig(config) {
    this.config = config
    return this.saveConfig(this.config)
  }

  // return -1 if not found
  //        index if found 

  find(map) {
    if (this.config == null || this.config.maps == null) {
      return -1;
    } else {
      for (let i in this.config.maps) {
        let _map = this.config.maps[i];
        if (_map.dport == map.dport && _map.toIP == map.toIP && _map.toPort == map.toPort) {
          return i;
        }
      }
    }
    return -1;
  }

  // save config should follow this
  addPort(map,init) {
    return async(()=>{
      if (init == false || init == null) {
        let old = this.find(map);
        if (old>=0) {
          if (this.config.maps[old].state == true) {
            log.info("PORTMAP:addPort Duplicated MAP",map);
            return;
          } else {
            this.config.maps[old] = map;
          }
        } else {
          this.config.maps.push(map);
        }
      }
      
      log.info("PORTMAP: Add",map);
      map.state = true;
      const dupMap = JSON.parse(JSON.stringify(map))
      dupMap.destIP = sysManager.myIp()
      let state = await (iptable.portforwardAsync(dupMap));
      return state;
    })().catch((err) => {
      log.error("Failed to add port mapping:", err, {})
    }) 
  }

  // save config should follow this
  removePort(map) {
    return async(()=>{
      let old = this.find(map);
      if (old >= 0) {
        this.config.maps[old].state = false;
        map = this.config.maps[old];
        this.config.maps.splice(old,1);
        log.info("PortForwarder:removePort Found MAP",map);
      } 
      map.state = false;
      // we call remove anyway ... even there is no entry
      const dupMap = JSON.parse(JSON.stringify(map))
      dupMap.destIP = sysManager.myIp()
      let state = await (iptable.portforwardAsync(dupMap));
      return state;
    })()
  }

  restore() {
    return async(()=>{
      log.info("PortForwarder:ApplyConfig ...")
      if (this.config && this.config.maps) {
        for (let i in this.config.maps) {
          let map = this.config.maps[i];
          log.info("Restoring Map: ",map,{});
          await (this.addPort(map,true));
        }
      }
    })().catch((err)=>{
    });
  }

  start() {
    log.info("PortForwarder:Starting PortForwarder ...")
    return async(() => {
      await (this.loadConfig())
      await (this.restore())
    })()
  }

  stop() {
    log.info("Stopping ip6in4...")
    return async(() => {
      await (this.saveConfig())
      
    })().catch((err) => {
    })
  }
}

module.exports = PortForward;
