'use strict';

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

let instance = null;

const log = require('../net2/logger.js')(__filename);

const f = require('../net2/Firewalla.js');

const configFile = `${f.getFirewallaHome()}/config.web.config`;

const cloud = require('../encipher');
const Promise = require('bluebird');

const jsonfile = require('jsonfile');
const readFileAsync = Promise.promisify(jsonfile.readFile);

const rclient = require('../util/redis_manager.js').getRedisClient();

class FireWeb {

  constructor() {
    if(instance === null) {
      instance = this;
    }

    return instance;
  }

  async getCloudInstance() {
    if(this.eptCloud) {
      return this.eptCloud;
    }

    try {
      const config = await readFileAsync(configFile);
      const name = config.name || "firewalla_web";
      const eptCloud = new cloud(name, null);
      await eptCloud.loadKeys();
      this.eptCloud = eptCloud;
    } catch(err) {
      log.error(`Failed to load config from file ${configFile}: ${err}`);
      return null;
    }
  }

  async enableWebToken(netbotCloud) {
    const eptCloud = await this.getCloudInstance();
    const gid = await rclient.hgetAsync("sys:ept", "gid");
    const isAdded = await this.isAdded(gid);
    if(!isAdded) { // add web token to group if not yet
      await this.addWebTokenToGroup(netbotCloud, gid);
    }

    // return a format to pass back to fireguard
    return {
      publicKey: eptCloud.myPublicKey,
      privateKey: eptCloud.myPrivateKey,
      gid: gid
    }
  }

  // Check if web token is already added to group gid
  async isAdded(gid) {
    const eptCloud = await this.getCloudInstance();
    try {
      const groupInfo = await eptCloud.groupFindAsync(gid);
      return true;
    } catch(err) {
      return false;
    }
  }

  async addWebTokenToGroup(netbotCloud, gid) {
    if(!netbotCloud) {
      return Promise.reject(new Error("Invalid Cloud Instance"));
    }

    const eptCloud = await this.getCloudInstance();

    if(eptCloud.eid) {
      try {
        const result = await netbotCloud.eptinviteGroupAsync(gid, this.eid);
        log.info(`Invite result: ${result}`);
        return;
      } catch(err) {
        log.error(`Failed to invite ${eptCloud.eid} to group ${gid}, err: ${err}`);
        return Promise.reject(err);
      }
    } else {
      return Promise.reject(new Error("Invalid Cloud Instance for Web"));
    }
  }
}

module.exports = new FireWeb();