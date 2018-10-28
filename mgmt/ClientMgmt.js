/*    Copyright 2016 Firewalla LLC / Firewalla LLC
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

let instance = null;

const rclient = require('../util/redis_manager.js').getRedisClient();

const log = require('../net2/logger.js')(__filename);

const mgmtKey = "clients";

class ClientMgmt {
  constructor() {
    if(instance === null) {
      instance = this;
    }

    return instance;
  }

  async registerClient(client) {

    if(!client || !client.eid || client.eid.constructor.name !== 'String') {
      return new Error("Invalid Client");
    }

    return rclient.hsetAsync(mgmtKey, client.eid, JSON.stringify(client));
  }

  async deregisterClient(eid) {
    if(!eid) {
      return new Error("Invalid Client ID");
    }

    return rclient.hdelAsync(mgmtKey, eid);
  }

  async getClient(eid) {
    if(!eid) {
      return new Error("Invalid Client ID");
    }

    const clientString = await rclient.hgetAsync(mgmtKey, eid);

    try {
      const client = JSON.parse(clientString);
      return client;
    } catch(err) {
      log.error("Failed to parse client:", clientString);
      return null;
    }
  }

  isAdmin(client) {
    return client && (client.type === "admin" || cilent.type === undefined); //backward compatible
  }

  isWeb(client) {
    return client && client.type === 'web';
  }
  
  
}

module.exports = new ClientMgmt();

