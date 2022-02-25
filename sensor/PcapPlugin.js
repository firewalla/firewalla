/*    Copyright 2016-2022 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const sem = require('../sensor/SensorEventManager.js').getInstance();
const scheduler = require('../util/scheduler.js');
const Message = require('../net2/Message.js');
const FireRouter = require('../net2/FireRouter.js');
const Config = require('../net2/config.js');
const extensionManager = require('./ExtensionManager.js');

class PcapPlugin extends Sensor {

  async apiRun() {
    extensionManager.onCmd(`${this.getFeatureName()}:restart`, async (msg, data) => {
      const enabled = Config.isFeatureOn(this.getFeatureName());
      if (enabled) {
        await this.restart().catch((err) => {
          log.error(`Failed to restart ${this.getFeatureName()}`, err.message);
          throw {msg: err.message, code: 500};
        });
      } else {
        throw {msg: `Feature ${this.getFeatureName()} is not enabled`, code: 400};
      }
    })
  }

  async run() {
    const supported = await this.isSupported();
    if (!supported) {
      log.warn(`${this.constructor.name} is not supported`);
      return;
    }
    this.enabled = false;
    this.hookFeature(this.getFeatureName());
    const restartJob = new scheduler.UpdateJob(this.restart.bind(this), 5000);
    await this.initLogProcessing();
    sem.on(Message.MSG_PCAP_RESTART_NEEDED, (event) => {
      if (this.enabled) {
        log.info(`Received event ${Message.MSG_PCAP_RESTART_NEEDED}, will restart pcap tool ${this.constructor.name}`);
        restartJob.exec().catch((err) => {
          log.error(`Failed to restart pcap job ${this.constructor.name}`, err.message);
        });
      }
    });
  }

  // this will be invoked only once when the class is loaded
  // the implementation should only create processors for log files from this pcap tool without touching upstream configurations
  async initLogProcessing() {

  }

  async globalOn() {
    this.enabled = true;
    log.info(`Pcap plugin ${this.getFeatureName()} is enabled`);
    await this.restart().catch((err) => {
      log.error(`Failed to start ${this.constructor.name}`, err.message);
    });
  }

  async globalOff() {
    this.enabled = false;
    log.info(`Pcap plugin ${this.getFeatureName()} is disabled`);
    await this.stop().catch((err) => {
      log.error(`Failed to stop ${this.constructor.name}`, err.message);
    });
  }

  async restart() {

  }

  async stop() {

  }

  async calculateListenInterfaces() {
    if (platform.isFireRouterManaged()) {
      const intfNameMap = await FireRouter.getInterfaceAll();
      const monitoringInterfaces = FireRouter.getMonitoringIntfNames();
      const parentIntfOptions = {};
      const monitoringIntfOptions = {}
      for (const intfName in intfNameMap) {
        if (!monitoringInterfaces.includes(intfName))
          continue;
        const intf = intfNameMap[intfName];
        const isBond = intfName && intfName.startsWith("bond") && !intfName.includes(".");
        const subIntfs = !isBond && intf.config && intf.config.intf;
        if (!subIntfs) {
          monitoringIntfOptions[intfName] = parentIntfOptions[intfName] = { pcapBufsize: this.getPcapBufsize(intfName) };
        } else {
          const phyIntfs = []
          if (typeof subIntfs === 'string') {
            // strip vlan tag if present
            phyIntfs.push(subIntfs.split('.')[0])
          } else if (Array.isArray(subIntfs)) {
            // bridge interface can have multiple sub interfaces
            phyIntfs.push(...subIntfs.map(i => i.split('.')[0]))
          }
          let maxPcapBufsize = 0
          for (const phyIntf of phyIntfs) {
            if (!parentIntfOptions[phyIntf]) {
              const pcapBufsize = this.getPcapBufsize(phyIntf)
              parentIntfOptions[phyIntf] = { pcapBufsize };
              if (pcapBufsize > maxPcapBufsize)
                maxPcapBufsize = pcapBufsize
            }
          }
          monitoringIntfOptions[intfName] = { pcapBufsize: maxPcapBufsize };
        }
      }
      if (monitoringInterfaces.length <= Object.keys(parentIntfOptions).length)
        return monitoringIntfOptions;
      else
        return parentIntfOptions;
    } else {
      const fConfig = await Config.getConfig(true);
      const intf = fConfig.monitoringInterface || "eth0";
      const listenInterfaces = {};
      listenInterfaces[intf] = {pcapBufsize: this.getPcapBufsize(intf)};
      return listenInterfaces;
    }
  }

  getPcapBufsize(intfName) {
    
  }

  getFeatureName() {
    return "";
  }

  async isSupported() {
    return true;
  }
}

module.exports = PcapPlugin;
