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

const Policy = require('../alarm/Policy.js');

const RuleStatsPlugin = require('../sensor/RuleStatsPlugin.js');
const PolicyManager2 = require('../alarm/PolicyManager2');

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

  it('should exclude network/tag-scoped rules from the global block list (issue #9361)', async () => {
    const globalPolicy = new Policy({type: "domain", action: "block", target: "doubleclick.net", pid: 100});
    const networkScopedPolicy = new Policy({type: "domain", action: "block", target: "doubleclick.net",
      tag: ["intf:e1eea2bd-7afd-4da4-b0d6-691778a92b60"], pid: 101});
    const tagScopedPolicy = new Policy({type: "domain", action: "block", target: "other-domain.com",
      tag: ["tag:5"], pid: 102});

    const origLoadActive = PolicyManager2.prototype.loadActivePoliciesAsync;
    PolicyManager2.prototype.loadActivePoliciesAsync = async () => [globalPolicy, networkScopedPolicy, tagScopedPolicy];
    const plugin = new RuleStatsPlugin({});
    plugin.on = true; // bypass globalOn()'s redis-touching first-time-init, only the filter is under test
    try {
      await plugin.loadBlockAllowGlobalRules();
    } finally {
      PolicyManager2.prototype.loadActivePoliciesAsync = origLoadActive;
    }

    const blockPids = plugin.policyRulesMap.get("block").map(p => p.pid);
    expect(blockPids).to.include(100);
    expect(blockPids).to.not.include(101);
    expect(blockPids).to.not.include(102);
  });

  it('should not let a hostless lookup poison a later hostful lookup on the same dh (issue #8012)', async () => {
    const ts = new Date() / 1000;
    const domainPolicy = new Policy({trust: true, protocol: "", disabled: 0, type: "domain", action: "allow", target: "example.org", dnsmasq_only: false, direction: "outbound", pid: 201});
    this.plugin.policyRulesMap = new Map();
    this.plugin.policyRulesMap.set("allow", [domainPolicy]);

    const base = { fd: "out", ac: "allow", type: "ip", sec: false, sh: "10.0.0.11", sp: [12345], dh: "93.184.216.34", dp: 443, pr: "tcp", qmark: null, ct: 1, ts };

    // hostless lookup misses, nothing to match the domain rule against yet
    let pids = await this.plugin.getMatchedPids(Object.assign({}, base));
    expect(pids).to.eql([]);

    // same five-tuple, but this call now carries the resolved hostname
    pids = await this.plugin.getMatchedPids(Object.assign({}, base, { af: { "example.org": {} } }));
    expect(pids).to.eql([201]);
  });

  it('should match an ip-type global allow rule against the source, not only the destination (issue #8012)', async () => {
    const ts = new Date() / 1000;
    const ipPolicy = new Policy({trust: true, protocol: "", disabled: 0, type: "ip", action: "allow", target: "10.0.0.21", dnsmasq_only: false, direction: "bidirection", pid: 202});
    this.plugin.policyRulesMap = new Map();
    this.plugin.policyRulesMap.set("allow", [ipPolicy]);

    // rule targets the source (A), not the destination (B) - this is the local A->B flow shape
    const record = { fd: "in", ac: "allow", type: "ip", sec: false, sh: "10.0.0.21", sp: [23456], dh: "8.8.8.8", dp: 443, pr: "tcp", qmark: null, ct: 1, ts };
    const pids = await this.plugin.getMatchedPids(record);
    expect(pids).to.eql([202]);
  });

  it('should match a net-type global allow rule against the source, not only the destination (issue #8012)', async () => {
    const ts = new Date() / 1000;
    const netPolicy = new Policy({trust: true, protocol: "", disabled: 0, type: "net", action: "allow", target: "10.0.1.0/24", dnsmasq_only: false, direction: "bidirection", pid: 203});
    this.plugin.policyRulesMap = new Map();
    this.plugin.policyRulesMap.set("allow", [netPolicy]);

    const record = { fd: "in", ac: "allow", type: "ip", sec: false, sh: "10.0.1.55", sp: [34567], dh: "8.8.4.4", dp: 443, pr: "tcp", qmark: null, ct: 1, ts };
    const pids = await this.plugin.getMatchedPids(record);
    expect(pids).to.eql([203]);
  });

  it('should NOT match an outbound-only ip rule against the source (direction must gate src/dst matching)', async () => {
    const ts = new Date() / 1000;
    // control/Block.js's generateRules(): direction "outbound" only ever enforces
    // target-as-destination; matching it against the source too would widen the
    // rule's effect beyond what enforcement actually does.
    const ipPolicy = new Policy({trust: true, protocol: "", disabled: 0, type: "ip", action: "allow", target: "10.0.0.22", dnsmasq_only: false, direction: "outbound", pid: 204});
    this.plugin.policyRulesMap = new Map();
    this.plugin.policyRulesMap.set("allow", [ipPolicy]);

    // target is the source here, not the destination - an outbound-only rule must not match
    // (distinct sh/dh from the earlier bidirection test, to avoid a stale cache hit)
    const record = { fd: "in", ac: "allow", type: "ip", sec: false, sh: "10.0.0.22", sp: [23457], dh: "8.8.8.9", dp: 443, pr: "tcp", qmark: null, ct: 1, ts };
    const pids = await this.plugin.getMatchedPids(record);
    expect(pids).to.eql([]);
  });

  it('should NOT match an inbound-only ip rule against the destination', async () => {
    const ts = new Date() / 1000;
    // direction "inbound" only ever enforces target-as-source (see control/Block.js's
    // generateRules()); matching it against the destination too would widen the rule.
    const ipPolicy = new Policy({trust: true, protocol: "", disabled: 0, type: "ip", action: "allow", target: "9.9.9.9", dnsmasq_only: false, direction: "inbound", pid: 205});
    this.plugin.policyRulesMap = new Map();
    this.plugin.policyRulesMap.set("allow", [ipPolicy]);

    // target is the destination here, not the source - an inbound-only rule must not match
    const record = { fd: "out", ac: "allow", type: "ip", sec: false, sh: "10.0.0.5", sp: [23456], dh: "9.9.9.9", dp: 443, pr: "tcp", qmark: null, ct: 1, ts };
    const pids = await this.plugin.getMatchedPids(record);
    expect(pids).to.eql([]);
  });
});
