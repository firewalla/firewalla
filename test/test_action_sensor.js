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
const _ = require('lodash');
const ActionPlugin = require('../sensor/ActionPlugin.js');
const rclient = require('../util/redis_manager').getRedisClient();
const log = require('../net2/logger.js')(__filename);


describe('Test ActionPlugin', function() {
    this.timeout(30000);
    this.plugin = new ActionPlugin({});

    // records with a unique item to isolate hiddenAction/matchPlatform tests from global data
    const hidden = `{"ts": 1001, "action":{"item":"test:action","autoTriggered":true}, "mtype":"cmd", "appInfo":{"platform":"ios"}}`;
    const iosRecord = `{"ts": 1002, "action":{"item":"test:action"}, "mtype":"cmd", "appInfo":{"platform":"ios"}}`;
    const androidRecord = `{"ts": 1003, "action":{"item":"test:action"}, "mtype":"cmd", "appInfo":{"platform":"android"}}`;

    before((done) => {
      (async() =>{
        const ts = Date.now() / 1000;
        await rclient.zaddAsync("action:history", ts-1, `{"ts": 111, "action":{"item":"policy:delete"}, "mtype":"cmd"}`);
        await rclient.zaddAsync("action:history", ts-2, `{"ts": 222, "action":{"item":"policy:update"}, "mtype":"cmd"}`);
        await rclient.zaddAsync("action:history", ts-3, `{"ts": 333, "action":{"item":"policy:create"}, "mtype":"cmd"}`);
        await rclient.zaddAsync("action:history", ts-4, `{"ts": 444, "action":{"item":"policy"}, "mtype":"set"}`);
        await rclient.zaddAsync("action:history", ts-5, hidden);
        await rclient.zaddAsync("action:history", ts-6, iosRecord);
        await rclient.zaddAsync("action:history", ts-7, androidRecord);
        done();
      })();
    });

    after((done) => {
      (async() => {
        await rclient.zremAsync("action:history", `{"ts": 111, "action":{"item":"policy:delete"}, "mtype":"cmd"}`);
        await rclient.zremAsync("action:history", `{"ts": 222, "action":{"item":"policy:update"}, "mtype":"cmd"}`);
        await rclient.zremAsync("action:history", `{"ts": 333, "action":{"item":"policy:create"}, "mtype":"cmd"}`);
        await rclient.zremAsync("action:history", `{"ts": 444, "action":{"item":"policy"}, "mtype":"set"}`);
        await rclient.zremAsync("action:history", hidden);
        await rclient.zremAsync("action:history", iosRecord);
        await rclient.zremAsync("action:history", androidRecord);
        done();
      })();
    });

    it('should get action history', async() => {
      let result;
      result = await this.plugin.getActionHistory({count: 10});
      expect(result.actions.length).to.equal(10);

      result = await this.plugin.getActionHistory({item: "policy:update", count:10, reverse: true});
      expect(result.actions.length).to.not.be.empty;

      result = await this.plugin.getActionHistory({items: ["policy:delete", "policy:create"], count:10, reverse: true});
      expect(result.actions.length).to.not.be.empty;

      result = await this.plugin.getActionHistory({mtype: "set", item: "policy", count:10, reverse: true});
      expect(result.actions.length).to.not.be.empty;
    })

    it('should hide autoTriggered actions', async() => {
      const result = await this.plugin.getActionHistory({item: "test:action", count: 100, reverse: true});
      expect(result.actions.length).to.equal(2); // hidden autoTriggered record excluded
      expect(result.actions.every(a => !(a.action && a.action.autoTriggered))).to.be.true;
    })

    it('should filter by platform', async() => {
      let result = await this.plugin.getActionHistory({item: "test:action", platform: "ios", count: 100, reverse: true});
      expect(result.actions.length).to.equal(1); // ios record, hidden ios record still excluded
      expect(result.actions[0].appInfo.platform).to.equal("ios");

      result = await this.plugin.getActionHistory({item: "test:action", platform: "ios,android", count: 100, reverse: true});
      expect(result.actions.length).to.equal(2); // comma-separated platforms
    })
});