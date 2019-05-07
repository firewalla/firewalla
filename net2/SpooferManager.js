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

let firewalla = require('./Firewalla.js');

let BitBridge = require('../extension/bitbridge/bitbridge.js')

var spawn = require('child_process').spawn;

let spawnProcess = null;

let spoofLogFile = firewalla.getLogFolder() + "/spoof.log";

let SysManager = require("./SysManager.js");
let sysManager = new SysManager();

let Promise = require('bluebird');

const async = require('asyncawait/async')
const await = require('asyncawait/await')

const iptool = require('ip')

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()

let log = require("./logger.js")(__filename, 'info');

let fs = require('fs');

let cp = require('child_process');

let monitoredKey = "monitored_hosts";
let unmonitoredKey = "unmonitored_hosts";
const unmonitoredKeyAll = "unmonitored_hosts_all";
let monitoredKey6 = "monitored_hosts6";
let unmonitoredKey6 = "unmonitored_hosts6";
const sem = require('../sensor/SensorEventManager.js').getInstance();

let HostTool = require('../net2/HostTool')
let hostTool = new HostTool();
const fc = require('./config.js')

let exec = require('child-process-promise').exec

let instance = null;

module.exports = class SpooferManager {
  constructor() {
    if (!instance) {
      this.spoofStarted = false;
      this.registeredSpoofInstances = {};
      (async () => {
        const gatewayIp = sysManager.myGateway();
        this.gatewayMac = await hostTool.getMacByIP(gatewayIp);
      })();

      if (firewalla.isMain()) {
        sem.on("DeviceUpdate", (event) => {
          const host = event.host;
          if (sysManager.myGateway6() && this.gatewayMac && host.mac === this.gatewayMac 
            && host.ipv6Addr && sysManager.myDNS().includes(sysManager.myGateway())) {
            // v4 dns includes gateway ip, very likely gateway's v6 addresses are dns servers, need to spoof these addresses (no matter public or linklocal)
            log.info("Router also acts as dns, spoof all router's v6 addresses: ", host.ipv6Addr);
            for (let i in host.ipv6Addr) {
              const addr = host.ipv6Addr[i];
              this.registerSpoofInstance(sysManager.monitoringInterface().name, addr, sysManager.myIp6(), true);
            }
          }
        });

        sclient.subscribe("System:IPChange")
        
        sclient.on("message", (channel, message) => {
          switch (channel) {
            case "System:IPChange":
              this.registerSpoofInstance(sysManager.monitoringInterface().name, sysManager.myGateway(), sysManager.myIp(), false);
              if (sysManager.myGateway6()) {
                this.registerSpoofInstance(sysManager.monitoringInterface().name, sysManager.myGateway6(), sysManager.myIp6()[0], true);
              }
              break;
            default:
          }
        });

        // feature change listener
        (async () => {
          let ipv6Default = false;
          if (firewalla.isBeta() || firewalla.isAlpha() || firewalla.isDevelopmentVersion()) {
            ipv6Default = true;
          }
          if(fc.isFeatureOn("ipv6", ipv6Default)) {
            await this.ipv6On();
          } else {
            await this.ipv6Off();
          }
          fc.onFeature("ipv6", (feature, status) => {
            if(feature != "ipv6")
              return
            
            if(status) {
              this.ipv6On()
            } else {
              this.ipv6Off()
            }
          })          
        })()
      }
      instance = this;
    }
    return instance;
  }

  registerSpoofInstance(intf, routerIP, selfIP, isV6) {
    const key = this._getSpoofInstanceKey(intf, routerIP, selfIP, isV6);
    if (!key)
      return;
      
    if (!this.registeredSpoofInstances[key]) {
      this.registeredSpoofInstances[key] = BitBridge.createInstance(intf, routerIP, selfIP, isV6);
      if (this.spoofStarted) {
        this.registeredSpoofInstances[key].start();
      }
    } else {
      const oldInstance = this.registeredSpoofInstances[key];
      const newInstance = BitBridge.createInstance(intf, routerIP, selfIP, isV6);
      if (newInstance !== oldInstance) {
        // need to deregister old instance
        this.deregisterSpoofInstance(intf, routerIP, selfIP, isV6);
        this.registeredSpoofInstances[key] = newInstance;
        if (this.spoofStarted) {
          newInstance.start();
        }
      }
    }
  }
  
  deregisterSpoofInstance(intf, routerIP, selfIP, isV6) {
    const key = this._getSpoofInstanceKey(intf, routerIP, selfIP, isV6);
    if (!key)
      return;
  
    if (this.registeredSpoofInstances[key]) {
      const spoofInstance = this.registeredSpoofInstances[key];
      if (this.spoofStarted) {
        spoofInstance.stop();
      }
      delete this.registeredSpoofInstances[key];
    }
  }
  
  _getSpoofInstanceKey(intf, routerIP, selfIP, isV6) {
    isV6 = isV6 || false;
    if (!routerIP) {
      log.error("Cannot create bitbridge instance. Router IP should be specified.");
      return null;
    }
    if (!selfIP && !isV6) {
      log.error("Cannot create bitbridge instance. Self IP should be specified for ipv4.");
      return null;
    }
    intf = intf || "eth0";
    if (isV6) {
      return `${intf}_v6_${routerIP}`;
    } else {
      return `${intf}_v4_${routerIP}`;  
    }
  }

  async ipv6On() {
    try {
      await exec("touch /home/pi/.firewalla/config/enablev6");
      await exec("pidof bitbridge6 && sudo pkill bitbridge6; true");
    } catch(err) {
      log.warn("Error when turn on ipv6", err);
    }
  }

  async ipv6Off() {
    try {
      await exec("rm -f /home/pi/.firewalla/config/enablev6");
      await exec("pidof bitbridge6 && sudo pkill bitbridge6; true");
    } catch(err) {
      log.warn("Error when turn off ipv6", err);
    }
  }
  
  // WORKAROUND VERSION HERE, will move to a better place
  async startSpoofing() {
  
    if(this.spoofStarted) {
      return;
    }
    
    log.info("start spoofing")
  
    await this.emptySpoofSet(); // all monitored_hosts* keys are cleared during startup

    await BitBridge.cleanupSpoofInstanceConfigs(); // cleanup Bitbridge config files (*.rc)
  
    for (let key in this.registeredSpoofInstances) {
      const spoofInstance = this.registeredSpoofInstances[key];
      spoofInstance.start();
    }
      
    /*
    let ifName = sysManager.monitoringInterface().name;
    let routerIP = sysManager.myGateway();
    let myIP = sysManager.myIp();
    let gateway6 = sysManager.myGateway6();
      
    if(!ifName || !myIP || !routerIP) {
      return Promise.reject("require valid interface name, ip address and gateway ip address");
    }
      
    let b7 = new BitBridge(ifName, routerIP, myIP,null,null,gateway6)
    b7.start()
    */
      
    this.spoofStarted = true;
  }
  
  async stopSpoofing() {
    try {
      this.spoofStarted = false;
  
      for (let key in this.registeredSpoofInstances) {
        const spoofInstance = this.registeredSpoofInstances[key];
        await spoofInstance.stop();
      }
      /*
      let ifName = sysManager.monitoringInterface().name;
      let routerIP = sysManager.myGateway();
      let myIP = sysManager.myIp();
  
      if(!ifName || !myIP || !routerIP) {
        return Promise.reject("require valid interface name, ip address and gateway ip address");
      }
      
      let b7 = new BitBridge(ifName, routerIP, myIP)
      b7.stop()
        .then(() => {
          resolve()
        })
      */
    } catch (err) {
      //catch everything here
      log.error("Failed to stop spoofing:", err, {})
    }
  }
  
  directSpoof(ip) {
    return async(() => {
      if(iptool.isV4Format(ip)) {
        await (rclient.saddAsync(monitoredKey, ip))      
      } else if(iptool.isV6Format(ip)) {
        await (rclient.saddAsync(monitoredKey6, ip))
      } else {
        return Promise.reject(new Error("Invalid ip address: " + ip))
      }
    })()
  }
  
  emptySpoofSet() {
    return async(() => {
      // clean up redis key
      await (rclient.delAsync(monitoredKey))
      await (rclient.delAsync(unmonitoredKey))
      await (rclient.delAsync(unmonitoredKeyAll))
      await (rclient.delAsync(monitoredKey6))
      await (rclient.delAsync(unmonitoredKey6))    
    })()
  }
  
  loadManualSpoof(mac) {
    return async(() => {
      let key = hostTool.getMacKey(mac)
      let host = await (rclient.hgetallAsync(key))
      let manualSpoof = (host.manualSpoof === '1' ? true : false)
      if(manualSpoof) {
        await (rclient.saddAsync(monitoredKey, host.ipv4Addr))
        await (rclient.sremAsync(unmonitoredKey, host.ipv4Addr))
        await (rclient.sremAsync(unmonitoredKeyAll, host.ipv4Addr))
      } else {
        await (rclient.sremAsync(monitoredKey, host.ipv4Addr))
        await (rclient.saddAsync(unmonitoredKey, host.ipv4Addr))
        await (rclient.saddAsync(unmonitoredKeyAll, host.ipv4Addr))
        setTimeout(() => {
          rclient.sremAsync(unmonitoredKey, host.ipv4Addr)
        }, 8 * 1000) // remove ip from unmonitoredKey after 8 seconds to reduce battery cost of unmonitored devices
      }    
    })()
  }
  
  loadManualSpoofs(hostManager) {
    log.info("Reloading manual spoof configurations...")
    let activeMACs = hostManager.getActiveMACs()
  
    return async(() => {
      await (emptySpoofSet()) // this is to ensure no other ip addresses are added to the list    
      activeMACs.forEach((mac) => {
        await (this.loadManualSpoof(mac))
      })
    })()
  }
  
  
  isSpoofRunning() {
    return async(() => {
      try {
        await (exec("pgrep -x bitbridge7"))
  
        // TODO: add ipv6 check in the future
      } catch(err) {      
        // error means no bitbridge7 is available
        log.warn("service bitbridge7 is not running (yet)")
        return false
      }
      return true
    })()
  }
  
  // TODO support ipv6
  isSpoof(ip) {
    return async(() => {
  
      try {
        await (exec("pgrep -x bitbridge7"))
  
        // TODO: add ipv6 check in the future
      } catch(err) {      
        // error means no bitbridge7 is available
        log.warn("service bitbridge7 is not running (yet)")
        return false
      }
      
      // BitBridge.getInstance() is not available for other nodejs processes than FireMain
      /*    
      let instance = BitBridge.getInstance()
      if(!instance) {
        return false
      }
  
      let started = instance.started
      if(!started) {
        return false
      }
      */
      
      return await (rclient.sismemberAsync(monitoredKey, ip)) == 1
    })()
  }
}
