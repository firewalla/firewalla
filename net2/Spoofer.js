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

var ipTool = require('ip');

let l2 = require('../util/Layer2.js');

var instance = null;

let log = require("./logger.js")(__filename, 'info');

let monitoredKey = "monitored_hosts";
let unmonitoredKey = "unmonitored_hosts";
// hosts in key unmonitored_hosts will be auto removed in 8 seconds.
// hosts in key unmonitored_hosts_all will not be auto removed
// key unmonitored_hosts_all is used to prevent same host from inserting to unmonitored_hosts multiple times
// this way can reduce amount of good arp spoofs.
const unmonitoredKeyAll = "unmonitored_hosts_all";
let monitoredKey6 = "monitored_hosts6";

const addrIfaceMap = {};

const sysManager = require('./SysManager.js');

const rclient = require('../util/redis_manager.js').getRedisClient()

let cp = require('child-process-promise');

let mode = require('./Mode.js')

module.exports = class {

  async newSpoof(address, iface) {
    iface = iface || addrIfaceMap[address];
    if (!iface)
      return;
    addrIfaceMap[address] = iface;
    if (sysManager.myIp(iface) === sysManager.myGateway(iface))
      return;

    let flag = await mode.isSpoofModeOn();
    if (!flag)
      return;

    const subMonitoredKey = `monitored_hosts_${iface}`;
    const subUnmonitoredKey = `unmonitored_hosts_${iface}`;
    const isMember = await rclient.sismemberAsync(monitoredKey, address);
    if (!isMember) {
      // Spoof redis set is cleared during initialization, see SpooferManager.startSpoofing()
      // This can ensure that all monitored hosts are added to redis set and ip set at the beginning
      // It's unnecessary to add ip address to monitored_ip_set that are already in redis set
      const cmd = `sudo ipset add -! monitored_ip_set ${address}`;
      await cp.exec(cmd);
      // add membership at the end
      await rclient.saddAsync(monitoredKey, address);
    }
    await rclient.saddAsync(subMonitoredKey, address);

    await rclient.sremAsync(unmonitoredKeyAll, address);
    await rclient.sremAsync(unmonitoredKey, address);
    await rclient.sremAsync(subUnmonitoredKey, address);

  }

  async newUnspoof(address, iface) {
    iface = iface || addrIfaceMap[address];
    if (!iface)
      return;
    addrIfaceMap[address] = iface;

    let flag = await mode.isSpoofModeOn();
    if (!flag)
      return;
    
    const subMonitoredKey = `monitored_hosts_${iface}`;
    const subUnmonitoredKey = `unmonitored_hosts_${iface}`;
    let isMember = await rclient.sismemberAsync(monitoredKey, address);
    if (isMember) {
      await rclient.sremAsync(monitoredKey, address);
      const cmd = `sudo ipset del -! monitored_ip_set ${address}`;
      await cp.exec(cmd);
    }
    await rclient.sremAsync(subMonitoredKey, address);
    isMember = await rclient.sismemberAsync(unmonitoredKeyAll, address);
    if (!isMember) {
      await rclient.saddAsync(unmonitoredKey, address);
      await rclient.saddAsync(subUnmonitoredKey, address);
      await rclient.saddAsync(unmonitoredKeyAll, address);
      setTimeout(() => {
        rclient.sremAsync(unmonitoredKey, address);
        rclient.sremAsync(subUnmonitoredKey, address);
      }, 8 * 1000) // remove ip from unmonitoredKey after 8 seconds to reduce battery cost of unmonitored devices
    }
  }  

  /* spoof6 is different than ipv4.  Some hosts may take on random addresses
   * hence storing a unmonitoredKey list does not make sense.
   */

  async newSpoof6(address, iface) {
    iface = iface || addrIfaceMap[address];
    if (!iface)
      return;
    addrIfaceMap[address] = iface;
    if (sysManager.myIp(iface) === sysManager.myGateway(iface))
      return;

    let flag = await mode.isSpoofModeOn();
    if (!flag)
      return;

    const subMonitoredKey6 = `monitored_hosts6_${iface}`;
    const isMember = await rclient.sismemberAsync(monitoredKey6, address);
    if (!isMember) {
      const cmd = `sudo ipset add -! monitored_ip_set6 ${address}`;
      await cp.exec(cmd);
      await rclient.saddAsync(monitoredKey6, address);
    }
    await rclient.saddAsync(subMonitoredKey6, address);
  }

  async newUnspoof6(address, iface) {
    iface = iface || addrIfaceMap[address];
    if (!iface)
      return;
    addrIfaceMap[address] = iface;

    let flag = await mode.isSpoofModeOn();
    if (!flag)
      return;

    const subMonitoredKey6 = `monitored_hosts6_${iface}`;
    const isMember = await rclient.sismemberAsync(monitoredKey6, address);
    if (isMember) {
      await rclient.sremAsync(monitoredKey6, address);
      const cmd = `sudo ipset del -! monitored_ip_set6 ${address}`;
      await cp.exec(cmd);
    }
    await rclient.sremAsync(subMonitoredKey6, address);
  }
  
  /* This is to be used to double check to ensure stale ipv6 addresses are not spoofed
   */
  validateV6Spoofs(ipv6Addrs) {
    let v6db = {};
    for (let i in ipv6Addrs) {
      v6db[ipv6Addrs[i]] = true;
    }
    rclient.smembers(monitoredKey6,(err,datas)=>{
      if (datas) {
        for (let i in datas) {
          if (v6db[datas[i]] == null) {
            log.info("Spoof6:Remove:By:Check", datas[i]);
            this.newUnspoof6(datas[i]);
          }         
        }
      }
    });
  }

  validateV4Spoofs(ipv4Addrs) {
    log.debug("Spoof4:Remove:By:Check:",JSON.stringify(ipv4Addrs));
    let v4db = {};
    for (let i in ipv4Addrs) {
      v4db[ipv4Addrs[i]] = true;
    }
    rclient.smembers(monitoredKey,(err,datas)=>{
      if (datas) {
        for (let i in datas) {
          if (v4db[datas[i]] == null) {
            log.info("Spoof4:Remove:By:Check:Device", datas[i]);
            this.newUnspoof(datas[i]);
          }         
        }
      }
    });
  }

    clean(ip) {
        let cmdline = 'sudo pkill -f bitbridge4';
        if (ip != null) {
            cmdline = "sudo pkill -f 'bitbridge4 " + ip + "'";
        }
        log.info("Spoof:Clean:Running commandline: ", cmdline);

      return new Promise((resolve, reject) => {
        let p = require('child_process').exec(cmdline, (err, stdout, stderr) => {
          if (err) {
            log.error("Failed to clean up spoofing army: " + err);
          }
          resolve();
        });
      });
    }

    clean6(ip) {
        let cmdline = 'sudo pkill -f bitbridge6a';
        if (ip != null) {
            cmdline = "sudo pkill -f 'bitbridge6a " + ip + "'";
        }
        log.info("Spoof:Clean:Running commandline: ", cmdline);

        let p = require('child_process').exec(cmdline, (err, out, code) => {
            log.info("Spoof:Clean up spoofing army", cmdline, err, out);
        });
    }

  constructor(config, clean) {

        // Warning, should not clean default ACL's applied to ip tables
        // there is one applied for ip6 spoof, can't be deleted
        if (clean == true) {
            this.clean();
            this.clean6();
        }
        if (instance == null) {
            this.config = config;
            this.spoofers = {};

            if (config == null || config.gateway == null) {
                this.gateway = "192.168.1.1"
            } else {
                this.gateway = config.gateway;
            }
            instance = this;
        } else {
            return instance;
        }
    }

}
