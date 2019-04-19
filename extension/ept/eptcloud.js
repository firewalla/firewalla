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
const log = require('../../net2/logger.js')(__filename);

const Promise = require('bluebird');

const rclient = require('../../util/redis_manager.js').getRedisClient()

class EptCloudExtension {
  constructor(eptcloud, gid) {
    this.eptcloud = eptcloud;
    this.gid = gid;
  }

  async job() {
    await this.updateGroupInfo(this.gid);
  }

  async recordAllRegisteredClients(gid) {
    const groupInfo = this.eptcloud.groupCache[gid] && this.eptcloud.groupCache[gid].group

    if(!groupInfo) {
      return
    }

    const deviceEID = groupInfo.eid;

    const clients = groupInfo.symmetricKeys.filter((client) => client.eid != deviceEID)

    const clientInfos = clients.map((client) => {
      return JSON.stringify({name: client.displayName, eid: client.eid})
    });

    const keyName = "sys:ept:members";

    const cmd = [keyName];

    cmd.push.apply(cmd, clientInfos)

    await rclient.delAsync(keyName)
    
    if(clientInfos.length > 0) {
      await rclient.saddAsync(cmd)  
    }
  }


  async updateGroupInfo(gid) {
    return new Promise((resolve, reject) => {
      this.eptcloud.groupFind(gid, (err, group)=> {
        if (err) {
          log.info("Error looking up group", err, err.stack, {});
          reject(err);
          return;
        }
        
        if (group == null) {
          reject(err);
          return;
        }

        this.recordAllRegisteredClients(gid).then(() => {
          resolve();
        }).catch((err) => {
          reject(err);
        });
      }); 
    });
  }

  run() {
    this.job();
      
    setInterval(() => {
      this.job();
    }, 1000 * 60 * 30); // every thirty minutes
  }
}

module.exports = EptCloudExtension
