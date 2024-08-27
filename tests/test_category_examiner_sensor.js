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

const LRU = require('lru-cache');
const fc = require('../net2/config.js');

const bone = require('../lib/Bone.js');
const log = require('../net2/logger.js')(__filename);
const CategoryExaminerPlugin = require('../sensor/CategoryExaminerPlugin.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const CategoryUpdater = require('../control/CategoryUpdater.js');
const categoryUpdater = new CategoryUpdater();

const plugin = new CategoryExaminerPlugin();

plugin.confirmSet = new Set();
plugin.cache = new LRU();
plugin.baseUrl = 'http://127.0.0.1:9964';
plugin.cache = new LRU({
  max: 1000,
  maxAge: 1000 * 10, // 10 seconds
  updateAgeOnGet: false
});

describe('Test category examiner', function(){
  this.timeout(30000);

  before((done) => {
    (async() =>{
        process.title="FireMain";
        await rclient.setAsync('sys:bone:url', 'https://fwdev.encipher.io/bone/api/dv5');
        bone.setEndpoint(await rclient.getAsync('sys:bone:url'));
        const jwt = await rclient.getAsync('sys:bone:jwt');
        bone.setToken(jwt);
        await categoryUpdater.activateCategory('av');
        await categoryUpdater.activateCategory('av_bf');
        await categoryUpdater.activateCategory('porn');
        await categoryUpdater.activateCategory('porn_bf');
        await categoryUpdater.activateCategory('games');
        await categoryUpdater.activateCategory('games_bf');
        await categoryUpdater.activateCategory('oisd');
        await fc.syncDynamicFeatures();
        done();
    })();
  });

  after((done) => {
    done();
  });

  it('should get category intels', async() => {
    expect((await plugin._getCloudIntels("www.onlyfans.com")).map(i => i.c)).to.be.eql(['porn']);
    expect((await plugin._getCloudIntels("static2.onlyfans.com")).map(i => i.c)).to.be.eql(['porn']);
    expect((await plugin._getCloudIntels("clienttoken.spotify.com")).map(i => i.c)).to.be.eql([]);
    expect((await plugin._getCloudIntels("www.spotify.com")).map(i => i.c)).to.be.eql([]);
    expect((await plugin._getCloudIntels("accounts.nintendo.com")).map(i => i.c)).to.be.eql(['games']);
    expect((await plugin._getCloudIntels("cdn.accounts.nintendo.com")).map(i => i.c)).to.be.eql(['games']);
    expect((await plugin._getCloudIntels("store.steampowered.com")).map(i => i.c)).to.be.eql(['games']);
    expect((await plugin._getCloudIntels("stats.zotabox.com")).map(i => i.c)).to.be.eql(['ad']);
  });

  it('should get exclude domains', async() => {
    const results = await plugin._getCategoryExcludeDomains(['av_bf', 'porn_bf', 'games']);
    expect(results.games.length).to.be.equal(await rclient.scardAsync('category:games:exclude:domain'));
    expect(results.porn_bf.length).to.be.equal(await rclient.scardAsync('category:porn:exclude:domain'));
    expect(results.av_bf.length).to.be.equal(await rclient.scardAsync('category:av:exclude:domain'));
  });

  it('should confirm set', async() => {
    plugin.confirmSet.add("porn_bf:*.onlyfans.com:www.onlyfans.com");
    plugin.confirmSet.add("porn_bf:*.static.onlyfans.com:static2.onlyfans.com");
    plugin.confirmSet.add("oisd:*.zztube.com:www.zztube.com");
    await plugin.confirmJob();
  });

  it.skip('should detect domain', async() => {
    await plugin.detectDomain("global.poe.live-video.net");
    log.debug("global.poe.live-video.net", plugin.confirmSet);
    expect(plugin.confirmSet.size).to.be.equal(1);

    await plugin.detectDomain("youtu.be");
    expect(plugin.confirmSet.size).to.be.equal(0);

    await plugin.detectDomain("cdn.accounts.nintendo.com");
    expect(plugin.confirmSet.size).to.be.equal(1);

    await plugin.detectDomain("accounts.nintendo.com");
    expect(plugin.confirmSet.size).to.be.not.empty;

    await plugin.detectDomain("store.steampowered.com");
    expect(plugin.confirmSet.size).to.be.not.empty;

    await plugin.detectDomain("www.onlyfans.com");
    expect(plugin.confirmSet.size).to.be.not.empty;

    await plugin.detectDomain("www.pornhub.com");
    expect(plugin.confirmSet.size).to.be.not.empty;

    await plugin.detectDomain("s-odx.oleads.com");
    log.debug("confirmSet", plugin.confirmSet);
    expect(plugin.confirmSet.size).to.be.not.empty;
  });

  it("should refresh category filter", async() => {
    await plugin.refreshCategoryFilter("av_bf");
    await plugin.refreshCategoryFilter("porn_bf");
    await plugin.refreshCategoryFilter("games_bf");
  });

});

describe('Test match domain', function(){
  this.timeout(30000);

  before((done) => {
    (async() =>{
      bone.setEndpoint(await rclient.getAsync('sys:bone:url'));
      const jwt = await rclient.getAsync('sys:bone:jwt');
      bone.setToken(jwt);
      done();
    })();
  });

  after((done) => {
    done();
  });

  it('should match domain', async() => {
    const resp = await plugin.matchDomain('static.onlyfans.com');
    log.debug("match result", resp)
    expect(resp.results.length).to.be.not.empty;
    expect(resp.results.map(i => i.status)).to.be.include('Match');
    expect(resp.results.filter(i => i.status=='Match').map(i => i.item)).to.be.include('*.onlyfans.com');
  });

  it('should match domain', async() => {
    const resp = await plugin.matchDomain('onlyfans.com');
    log.debug("match result", resp)
    expect(resp.results.length).to.be.not.empty;
    expect(resp.results.map(i => i.status)).to.be.include('Match');
    expect(resp.results.map(i => i.item)).to.be.include('*.onlyfans.com');
  });

  it('should confirm domains', async() => {
    const domainList = ['*.onlyfans.com'];
    const result = await plugin.confirmDomainsFromCloud('porn_bf', domainList)
    expect(result).to.be.eql(['*.onlyfans.com']);
  });

  it('should confirm domains', async() => {
    const domainList = ['s-odx.oleads.com'];
    const result = await plugin.confirmDomainsFromCloud('oisd', domainList)
    expect(result).to.be.eql(['s-odx.oleads.com']);
  });
});