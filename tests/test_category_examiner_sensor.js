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

  beforeEach((done) => {
    (async() =>{
        bone.setEndpoint(await rclient.getAsync('sys:bone:url'));
        const jwt = await rclient.getAsync('sys:bone:jwt');
        bone.setToken(jwt);
        done();
    })();
  });

  afterEach((done) => {
    done();
  });

  it('should find category', async() => {
    log.error("test find category")
    expect(await plugin._findCategory("www.onlyfans.com")).to.be.eql(['porn']);
    expect(await plugin._findCategory("static2.onlyfans.com")).to.be.eql(['porn']);
    expect(await plugin._findCategory("stats.zotabox.com")).to.be.eql(['adblock_strict']);
  });

  it('should confirm set', async() => {
    plugin.confirmSet.add("porn_bf:*.onlyfans.com:www.onlyfans.com");
    plugin.confirmSet.add("porn_bf:*.static.onlyfans.com:static2.onlyfans.com");
    await plugin.confirmJob();
  });

});

describe('Test match domain', function(){
  this.timeout(30000);

  beforeEach((done) => {
    (async() =>{
      bone.setEndpoint(await rclient.getAsync('sys:bone:url'));
      const jwt = await rclient.getAsync('sys:bone:jwt');
      bone.setToken(jwt);
      done();
    })();
  });

  afterEach((done) => {
    done();
  });

  it('should match domain', async() => {
    const resp = await plugin.matchDomain('static.onlyfans.com');
    log.debug("match result", resp)
    expect(resp.results.length).to.be.not.empty;
    expect(resp.results.map(i => i.status)).to.be.include('Match');
    expect(resp.results.map(i => i.item)).to.be.include('*.static.onlyfans.com');
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
});