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

const log = require("./logger.js")(__filename, 'info');

const monitoredKey = "monitored_hosts";
const unmonitoredKey = "unmonitored_hosts";
// hosts in key unmonitored_hosts will be auto removed in 8 seconds.
// hosts in key unmonitored_hosts_all will not be auto removed
// key unmonitored_hosts_all is used to prevent same host from inserting to unmonitored_hosts multiple times
// this way can reduce amount of good arp spoofs.
const unmonitoredKeyAll = "unmonitored_hosts_all";
let monitoredKey6 = "monitored_hosts6";

const addrIfaceMap = {};

const rclient = require('../util/redis_manager.js').getRedisClient()

let cp = require('child-process-promise');

let mode = require('./Mode.js')

class Spoofer {

  async newSpoof(address, iface) {
    iface = iface || addrIfaceMap[address];
    if (!iface)
      return;

    let flag = await mode.isSpoofModeOn();
    if (!flag)
      return;

    // address changed to a different interface, remove it from previous spoof set
    if (addrIfaceMap[address] && addrIfaceMap[address] !== iface) {
      log.info(`${address} moves to ${iface}, remove it from ${addrIfaceMap[address]}`);
      await this.newUnspoof(address, addrIfaceMap[address]);
    }
    addrIfaceMap[address] = iface;

    const subMonitoredKey = `monitored_hosts_${iface}`;
    const subUnmonitoredKey = `unmonitored_hosts_${iface}`;
    const isMember = await rclient.sismemberAsync(monitoredKey, address);
    if (!isMember) {
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

    let flag = await mode.isSpoofModeOn();
    if (!flag)
      return;

    // address changed to a different interface, remove it from previous spoof set
    if (addrIfaceMap[address] && addrIfaceMap[address] !== iface) {
      log.info(`${address} moves to ${iface}, remove it from ${addrIfaceMap[address]}`);
      await this.newUnspoof6(address, addrIfaceMap[address]);
    }
    addrIfaceMap[address] = iface;

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
  async validateV6Spoofs(ipv6Addrs) {
    const compareSet = new Set(ipv6Addrs)
    const monitoredIpSet = await rclient.smembersAsync(monitoredKey6)
    for (const ip of monitoredIpSet) {
      if (!compareSet.has(ip)) {
        log.info("Spoof6:Remove:By:Check", ip);
        await this.newUnspoof6(ip).catch(log.error)
      }
    }
  }

  async validateV4Spoofs(ipv4Addrs) {
    log.debug("Spoof4:Remove:By:Check:",JSON.stringify(ipv4Addrs));
    const compareSet = new Set(ipv4Addrs)
    const monitoredIpSet = await rclient.smembersAsync(monitoredKey)
    for (const ip of monitoredIpSet) {
      if (!compareSet.has(ip)) {
        log.info("Spoof4:Remove:By:Check:Device", ip);
        await this.newUnspoof(ip).catch(log.error)
      }
    }
  }
}

module.exports = new Spoofer()
