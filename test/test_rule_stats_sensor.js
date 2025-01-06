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


process.title = "FireMain";

const LRU = require('lru-cache');

const Policy = require('../alarm/Policy.js');

const RuleStatsPlugin = require('../sensor/RuleStatsPlugin.js');

describe('test rule stats policy cache', function(){
  this.timeout(3000);

  before((done) => {
    this.plugin = new RuleStatsPlugin({})
    this.plugin.cache = new LRU({max: 10, maxAge: 15 * 1000, updateAgeOnGet: false});
    done();
  });

  after((done) => {
    // source port 9999 for test
    done();
  });

  it('should get matched pids', async() => {
    const ts = new Date() / 1000;
    const record = {fd: "out", ac: "allow", type: "dns",  sec: false, dn: "www.chess.com", dh: "216.239.38.120", qmark:null, ct: 1, ts };
    this.plugin.policyRulesMap = new Map();
    const policy = new Policy({trust: true, protocol: "", disabled: 0, type: "dns", action:"allow", target:"www.chess.com", dnsmasq_only: false, direction: "outbound", pid: 88});
    
    this.plugin.policyRulesMap.set("allow", [policy]);

    // cache miss and set
    let pids = await this.plugin.getMatchedPids(record);
    expect(pids).to.eql([88]);

    // cache hit
    pids = await this.plugin.getMatchedPids(record);
    expect(pids).to.eql([88]);

  });
  
  it('should get no matched pids', async() => {
    const ts = new Date() / 1000;
    const record = {fd: "out", ac: "allow", type: "dns",  sec: false, dh: "216.239.38.120", qmark:null, ct: 1, ts };
    const policy = new Policy({trust: true, protocol: "", disabled: 0, type: "dns", action:"allow", target:"www.chess.com", dnsmasq_only: false, direction: "outbound", pid: 88});
    this.plugin.policyRulesMap = new Map();
    this.plugin.policyRulesMap.set("allow", [policy]);

    // cache miss and set
    let pids = await this.plugin.getMatchedPids(record);
    expect(pids).to.eql([]);

    // cache hit
    pids = await this.plugin.getMatchedPids(record);
    expect(pids).to.eql([]);

  });
});
