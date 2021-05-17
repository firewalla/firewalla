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

'use strict';

const events = require('events');
const exec = require('child-process-promise').exec;
const log = require('../../net2/logger.js')(__filename);

class VPNClient extends events.EventEmitter {
  constructor(options) {
    super();
  }

  async setup() {
  }

  async start() {
  }

  async stop() {
  }

  async status() {

  }

  async getStatistics() {

  }

  // applicable to pointtopoint interfaces
  async getRemoteIP() {
  }

  async getInterfaceName() {
  }

  static getRouteIpsetName(uid) {
    if (uid) {
      return `c_route_${uid.substring(0, 13)}_set`;
    } else
      return null;
  }

  static async ensureCreateEnforcementEnv(uid) {
    if (!uid)
      return;
    const routeIpsetName = VPNClient.getRouteIpsetName(uid);
    const routeIpsetName4 = `${routeIpsetName}4`;
    const routeIpsetName6 = `${routeIpsetName}6`;
    await exec(`sudo ipset create -! ${routeIpsetName} list:set skbinfo`).catch((err) => {
      log.error(`Failed to create vpn client routing ipset ${routeIpsetName}`, err.message);
    });
    await exec(`sudo ipset create -! ${routeIpsetName4} hash:net maxelem 10`).catch((err) => {
      log.error(`Failed to create vpn client routing ipset ${routeIpsetName4}`, err.message);
    });
    await exec(`sudo ipset create -! ${routeIpsetName6} hash:net family inet6 maxelem 10`).catch((err) => {
      log.error(`Failed to create vpn client routing ipset ${routeIpsetName6}`, err.message);
    });
  }
}

module.exports = VPNClient;