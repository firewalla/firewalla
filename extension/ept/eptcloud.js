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
const log = require('../../net2/logger.js')(__filename);

const rclient = require('../../util/redis_manager.js').getRedisClient()
const Constants = require('../../net2/Constants.js');

class EptCloudExtension {
  constructor(eptcloud, gid) {
    this.eptcloud = eptcloud;
    this.gid = gid;
  }

  async job() {
    try {
      await this.updateGroupInfo(this.gid);
    } catch(err) {
      log.error('Failed to refresh clients', err)
    }
  }

  async recordAllRegisteredClients(gid) {
    const groupInfo = this.eptcloud.groupCache[gid] && this.eptcloud.groupCache[gid].group

    if(!groupInfo) {
      return
    }

    const deviceEID = groupInfo.eid;

    const clients = groupInfo.symmetricKeys.filter((client) => client.eid != deviceEID)

    const clientInfos = clients.map(client =>
      JSON.stringify({ name: client.displayName, eid: client.eid })
    );

    const keyName = "sys:ept:members";

    const cmd = [keyName];

    cmd.push.apply(cmd, clientInfos)

    await rclient.unlinkAsync(keyName)

    if(clientInfos.length > 0) {
      await rclient.saddAsync(cmd)
    }

    await rclient.hmsetAsync('sys:ept:me', {
      eid: deviceEID,
      key: groupInfo.me.key
    })

    await rclient.setAsync(Constants.REDIS_KEY_GROUP_NAME, groupInfo.name);
  }


  async updateGroupInfo(gid) {
    const group = await this.eptcloud.groupFind(gid)

    if (group == null) {
      throw new Error('Invalid Group')
    }

    await this.recordAllRegisteredClients(gid)
  }

  run() {
    this.job();

    setInterval(() => {
      this.job();
    }, 1000 * 3600 * 24); // every day
  }
}

module.exports = EptCloudExtension
