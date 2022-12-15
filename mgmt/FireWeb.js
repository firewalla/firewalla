'use strict';

/*    Copyright 2016-2020 Firewalla Inc.
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

const configFile = `${f.getFirewallaHome()}/config/web.config`;

const cloud = require('../encipher');
const Promise = require('bluebird');

const jsonfile = require('jsonfile');
const readFileAsync = Promise.promisify(jsonfile.readFile);

const rclient = require('../util/redis_manager.js').getRedisClient();

const clientMgmt = require('./ClientMgmt.js');
const license = require('../util/license.js')
const EptCloudExtension = require('../extension/ept/eptcloud.js');
const Constants = require('../net2/Constants.js');

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
      const appId = config.appId;
      const appSecret = config.appSecret;

      const eptCloud = new cloud(name, null);
      await eptCloud.loadKeys();
      await eptCloud.eptLogin(appId, appSecret, null, name);

      // register as web
      const eid = eptCloud.eid;
      await clientMgmt.registerWeb({eid});

      this.eptCloud = eptCloud;
      return this.eptCloud;
    } catch(err) {
      log.error(`Failed to get cloud instance: ${err}`);
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
    const licenseJSON = license.getLicense()
    const licenseString = licenseJSON && licenseJSON.DATA && licenseJSON.DATA.UUID;
    // return a format to pass back to fireguard
    return {
      publicKey: eptCloud.mypubkeyfile.toString('ascii'),
      privateKey: eptCloud.myprivkeyfile.toString('ascii'),
      gid: gid,
      license: licenseString
    }
  }

  // Check if web token is already added to group gid
  async isAdded(gid) {
    const eptCloud = await this.getCloudInstance();
    try {
      const groups = await eptCloud.eptGroupList();
      for(const group of groups || []) {
        if(group.gid === gid) {
          return true;
        }
      }
      return false;
    } catch(err) {
      return false;
    }
  }

  async addWebTokenToGroup(netbotCloud, gid) {
    if(!netbotCloud) {
      throw new Error("Invalid Cloud Instance");
    }

    const eptCloud = await this.getCloudInstance();

    if(eptCloud.eid) {
      try {
        const result = await netbotCloud.eptInviteGroup(gid, eptCloud.eid);
        log.info("Invite result:", result);

        // remove from revoked eid set
        await rclient.sremAsync(Constants.REDIS_KEY_EID_REVOKE_SET, eptCloud.eid);

        (async () => {
          const eptCloudExtension = new EptCloudExtension(eptCloud, gid);
          await eptCloudExtension.updateGroupInfo(gid);
        })();

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
