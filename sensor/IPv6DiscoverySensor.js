/*    Copyright 2016-2019 Firewalla Inc.
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

/*
 * WANRING, Sending Event Disabled until everything is hooked up
 */

'use strict';

const asyncNative = require('../util/asyncNative.js');

const log = require('../net2/logger.js')(__filename);

const sem = require('../sensor/SensorEventManager.js').getInstance();

const Sensor = require('./Sensor.js').Sensor;

const networkTool = require('../net2/NetworkTool')();
const execAsync = require('child-process-promise').exec


class IPv6DiscoverySensor extends Sensor {
  constructor() {
    super();
    this.enabled = true; // very basic feature, always enabled
    let p = require('../net2/MessageBus.js');
    this.publisher = new p('info','Scan:Done', 10);
  }

  run() {
    setTimeout(()=> {
      this.checkAndRunOnce(true);

      setInterval(() => {
        this.checkAndRunOnce(true);
      }, 1000 * 60 * 5); // every 5 minutes, fast scan

    },1000*60*5); // start the first run in 5 minutes
  }

  async checkAndRunOnce() {
    log.info("Starting IPv6DiscoverySensor Scanning",new Date()/1000);
    if (this.isSensorEnabled()) {
      const results = await networkTool.getLocalNetworkInterface()
      if (results) {
        for (let i in results) {
          let intf = results[i];
          await this.neighborDiscoveryV6(intf.name, intf);
        }
      }
    }
  }

  isSensorEnabled() {
    return this.enabled;
  }

  async ping6ForDiscovery(intf, obj) {
    await execAsync(`ping6 -c2 -I ${intf} ff02::1`)
    return asyncNative.eachLimit(obj.ip6_addresses, 5, async (o) => {
      let pcmd = `ping6 -B -c 2 -I ${intf} -I ${o} ff02::1`;
      log.info("Discovery:v6Neighbor:Ping6", pcmd);
      return execAsync(pcmd)
    })
  }


  addV6Host(v6addrs,mac) {
    sem.emitEvent({
      type: "DeviceUpdate",
      message: `A new ipv6 is found @ IPv6DisocverySensor ${v6addrs} ${mac}`,
      suppressAlarm: true,
      host:  {
        ipv6Addr: v6addrs,
        mac: mac.toUpperCase(),
        from: "ip6neighbor"
      }
    });
  }

  async neighborDiscoveryV6(intf, obj) {
    if (obj.ip6_addresses == null || obj.ip6_addresses.length <= 1) {
      log.info("Discovery:v6Neighbor:NoV6", intf, JSON.stringify(obj));
      return;
    }
    await this.ping6ForDiscovery(intf, obj)
    let cmdline = 'ip -6 neighbor show';
    log.info("Running commandline: ", cmdline);

    const { stdout } = await execAsync(cmdline)
    let lines = stdout.split("\n");
    let macHostMap = {};
    for (const o of lines) {
      log.debug("Discover:v6Neighbor:Scan:Line", o, "of interface", intf);
      let parts = o.split(" ");
      if (parts[2] == intf) {
        let v6addr = parts[0];
        let mac = parts[4].toUpperCase();
        if (mac == "FAILED" || mac.length < 16) {
          continue
        } else {
          /*
            hostTool.linkMacWithIPv6(v6addr, mac,(err)=>{
            cb();
            });
          */
          let _host = macHostMap[mac];
          if (_host) {
            _host.push(v6addr);
          } else {
            _host = [v6addr];
            macHostMap[mac] = _host;
          }
          continue
        }
      }
    }
    for (let mac in macHostMap) {
      this.addV6Host(macHostMap[mac], mac)
    }

    // FIXME
    // This is a very workaround activity to send scan done out in 5 seconds
    // several seconds is necessary to ensure new ip addresses are added
    setTimeout(() => {
      log.info("IPv6 Scan:Done");
      this.publisher.publishCompressed("DiscoveryEvent", "Scan:Done", '0', {});
    }, 5000)

  }

  isSensorEnable() {
    return Promise.resolve(this.enabled);
  }

}

module.exports = IPv6DiscoverySensor;
