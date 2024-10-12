/*    Copyright 2016-2024 Firewalla Inc.
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

let chai = require('chai');
let expect = chai.expect;

let log = require('../net2/logger.js')(__filename, 'info');
const exec = require('child-process-promise').exec;
const rclient = require('../util/redis_manager.js').getRedisClient();

const WGPeer = require('../net2/identity/WGPeer.js');

describe('Test WgvpnConnSensor check peer activity', function(){
  this.timeout(3000);

  beforeEach(async() => {
    this.todelete = [];
    const results = await exec(`sudo wg show all latest-handshakes`).then(i => i.stdout.trim().split('\n')).catch((err) => {log.error(err.stderr)});
    for (let result of results) {
      const [intf, pubKey, latestHandshake] = result.split(/\s+/g);
      if (!isNaN(latestHandshake) || latestHandshake == '0') {
        const rpeerkey = `vpn:wg:peer:${intf}:${pubKey}`;
        this.todelete.push(rpeerkey);
        await rclient.hsetAsync(rpeerkey, "lastActiveTimestamp", 9999); // 9999 for test, delete at the after stage
      }
    }
  });

  afterEach(async() => {
    for (let delkey of this.todelete) {
      await rclient.delAsync(delkey);
    }
  });

  it('should getInitData', async() => {
    const data = await WGPeer.getInitData();
    for (let item of data) {
      expect(item.lastActiveTimestamp).not.to.be.null;
    }
  })
});
