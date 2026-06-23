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

const PolicyManager2 = require('../alarm/PolicyManager2.js');
const Policy = require('../alarm/Policy.js');
const Alarm = require('../alarm/Alarm.js');

const domainBlock = require('../control/DomainBlock.js');
const cloudcache = require('../extension/cloudcache/cloudcache');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const log = require('../net2/logger.js')(__filename);

describe('Test policy filter', function(){
    this.timeout(30000);
    let policyRules = [];

    before((done) => {
      const content = [
        {
          type: 'mac', action: 'block', direction: 'bidirection',
          timestamp: '1698162755.296', pid: '21', activatedTime: '1709174627.5555'
        },
        {
          type: 'intranet', action: 'block', direction: 'bidirection',
          timestamp: '1709176426.57', pid: '19', activatedTime: '1709174626.604'
        },
        {
          type: 'intranet', action: 'block', direction: 'outbound',
          timestamp: '1709144626.57', pid: '119', activatedTime: '1709174626.604'
        },
        {
          type: 'mac', action: 'allow', direction: 'bidirection',
          timestamp: '1708675027.46', pid: '3220', upnp: 1
        },
        {
          type: 'mac', action: 'block', direction: 'outbound', 
          timestamp: '1709144610.61', pid: '29',
        },
        {
          type: 'country', action: 'allow', direction: 'inbound',
          timestamp: '1701206563.059', pid: '1772', activatedTime: '1701226566.891'
        },
        {
          type: 'intranet', action: 'allow', direction: 'bidirection',
          timestamp: '1700055205.116', pid: '139', activatedTime: '1709174626.604'
        },
        {
          type: 'mac', action: 'qos', direction: 'bidirection',
          trafficDirection: 'upload', target: '20:6D:31:EF:FF:35',
          timestamp: '1646757685.122', activatedTime: '1646357685.296', pid: '1449'
        },
        {
          type: 'mac', action: 'allow', direction: 'inbound',
          timestamp: '1709174625.57', pid: '156', activatedTime: '1709174625.604'
        },
        {
          type: 'intranet', action: 'allow', direction: 'inbound',
          timestamp: '1709174626.57', pid: '159', activatedTime: '1709174626.604'
        },
        {
          type: 'dns', action: 'block', category: 'intel', direction: 'bidirection',
          timestamp: '1637111227.929', activatedTime: '1637229228.76', pid: '1484'
        },
        {
          type: 'intranet', action: 'allow', direction: 'outbound',
          timestamp: '1709164626.57', pid: '149', activatedTime: '1709174626.604'
        },
        {
          type: 'mac', action: 'allow', direction: 'outbound',
          timestamp: '1709179626.57', pid: '1687', activatedTime: '1700011206.375'
        },
        {
          type: 'device', action: 'allow', direction: 'inbound',
          timestamp: '1699077479.42', pid: '1585', activatedTime: '1699077980.017'
        },
        {
          type: 'mac', action: 'block', direction: 'inbound',
          timestamp: '1709174626.57', pid: '22', activatedTime: '1709174627.5555'
        },
        {
          type: 'remotePort', direction: 'outbound', action: 'allow',
          timestamp: '1648018597.597', pid: '1436',
        },
        {
          type: 'country', action: 'route', routeType: 'hard', 'wanUUID': 'uuid', 
          timestamp: '1642562789.692', activatedTime: '1642562789.313', pid: '1457'
        },
        {
          type: 'mac', action: 'block', direction: 'inbound',
          timestamp: '1709221626.61', pid: '87', activatedTime: '1709221626.991'
        },
        {
          type: 'intranet', action: 'block', direction: 'inbound',
          timestamp: '1708210800.61', pid: '129', activatedTime: '1709174626.604'
        },
        {
          type: 'mac', action: 'allow', direction: 'inbound',
          timestamp: '1708675108.753', pid: '3212'
        },
        {
          type: 'ip', action: 'block', direction: 'bidirection',
          timestamp: '1628152313.054', pid: '1508',
          trust: false, target: '117.136.8.132', upnp: false, 
          target_name: '117.136.8.132', dnsmasq_only: false
        },
        {
          type: 'category', action: 'allow', direction: 'inbound',
          timestamp: '1701226563.123', pid: '1773', activatedTime: '1701226571.035'
        }
      ];
      policyRules = content.map(r => {
        return new Policy(r);
      });

      policyRules.sort((a, b) => {
        return b.timestamp - a.timestamp;
      })

      done();
    });
  
    after((done) => {
      done();
    });
  
    it('should split policy rules', async()=> {
      const pm2 = new PolicyManager2();
      const [routeRules, 
        inboundBlockInternetRules, inboundAllowInternetRules,
        inboundBlockIntranetRules, inboundAllowIntranetRules,
        internetRules, intranetRules, outboundAllowRules, otherRules] = pm2.splitRules(policyRules);
      
      expect(routeRules.length).to.equal(1);
      expect(inboundBlockInternetRules.map(r => {return r.pid;})).to.eql(['87', '22']);
      expect(inboundAllowInternetRules.map(r => {return r.pid;})).to.eql(['156', '3212']);
      expect(inboundBlockIntranetRules.map(r => {return r.pid;})).to.eql(['129']);
      expect(inboundAllowIntranetRules.map(r => {return r.pid;})).to.eql(['159']);
      expect(internetRules.map(r => {return r.pid;})).to.eql(['29', '21']);
      expect(intranetRules.map(r => {return r.pid;})).to.eql(['19', '119']);
      expect(outboundAllowRules.map(r => {return r.pid;})).to.eql(['1687', '149', '3220', '139']);
      expect(otherRules.length).to.equal(7);
    });


    it('should get high-impact rules', async() => {
      const pm2 = new PolicyManager2();
      const rules = await pm2.getHighImpactfulRules();
      expect(rules).to.not.be.null;
    })

});

describe('Test remotePort policy protocol match', function(){
  this.timeout(30000);

  function pornAlarm(protocol) {
    const alarm = new Alarm.PornAlarm(1648018597, 'OLIVER1', 'hentaijuggs.com', {
      'p.device.mac': '98:59:7A:48:46:08',
      'p.dest.name': 'hentaijuggs.com',
      'p.dest.port': '443',
    });
    if (protocol) alarm['p.protocol'] = protocol;
    return alarm;
  }

  it('should not match when protocol differs (udp rule vs tcp flow)', () => {
    const policy = new Policy({ type: 'remotePort', target: '443', protocol: 'udp', action: 'block' });
    expect(policy.match(pornAlarm('tcp'))).to.be.false;
  });

  it('should match when protocol is the same', () => {
    const policy = new Policy({ type: 'remotePort', target: '443', protocol: 'tcp', action: 'block' });
    expect(policy.match(pornAlarm('tcp'))).to.be.true;
  });

  it('should match regardless of protocol when rule omits protocol', () => {
    const policy = new Policy({ type: 'remotePort', target: '443', action: 'block' });
    expect(policy.match(pornAlarm('tcp'))).to.be.true;
  });

  it('should enforce protocol on remotePort used as an extra condition', () => {
    const policy = new Policy({ type: 'domain', target: 'hentaijuggs.com', remotePort: '443', protocol: 'udp', action: 'block' });
    expect(policy.match(pornAlarm('tcp'))).to.be.false;
  });
});

describe('Test priorityCompare', function(){
  // returns <0 if `this` outranks the arg, >0 if arg wins, 0 if equal

  const intranetScopedToDevice = new Policy({
    pid: '101', type: 'intranet', action: 'block', direction: 'bidirection',
    scope: ['20:6D:31:01:2B:43'],
  });
  const deviceTargetAllScope = new Policy({
    pid: '102', type: 'device', action: 'block', direction: 'bidirection',
    target: '20:6D:31:01:2B:43',
  });
  const intranetAllScope = new Policy({
    pid: '103', type: 'intranet', action: 'block', direction: 'bidirection',
  });

  it('treats device-scoped and device-target local rules as equal priority', () => {
    expect(intranetScopedToDevice.priorityCompare(deviceTargetAllScope)).to.equal(0);
    expect(deviceTargetAllScope.priorityCompare(intranetScopedToDevice)).to.equal(0);
  });

  it('ranks a device-specific local rule above an all-scope one', () => {
    expect(deviceTargetAllScope.priorityCompare(intranetAllScope)).to.be.below(0);
    expect(intranetAllScope.priorityCompare(deviceTargetAllScope)).to.be.above(0);
  });

  it('reads tag scope from the `tag` field (device group = level 2)', () => {
    const tagGroupRule = new Policy({
      pid: '104', type: 'intranet', action: 'block', tag: ['tag:8'],
    });
    expect(deviceTargetAllScope.priorityCompare(tagGroupRule)).to.be.below(0);
    expect(tagGroupRule.priorityCompare(intranetAllScope)).to.be.below(0);
  });

  it('lets seq band override specificity', () => {
    const highSeqAllScope = new Policy({
      pid: '105', type: 'intranet', action: 'block', seq: 1,
    });
    expect(highSeqAllScope.priorityCompare(deviceTargetAllScope)).to.be.below(0);
  });

  it('prefers allow over block at the same specificity', () => {
    const allowDevice = new Policy({ pid: '106', type: 'device', target: 'AA:BB:CC:DD:EE:FF', action: 'allow' });
    const blockDevice = new Policy({ pid: '107', type: 'device', target: 'AA:BB:CC:DD:EE:FF', action: 'block' });
    expect(allowDevice.priorityCompare(blockDevice)).to.equal(-1);
    expect(blockDevice.priorityCompare(allowDevice)).to.equal(1);
  });
});

describe('Test policy filter', function(){
  this.timeout(30000);

  it('should get category domains', async () => {
    const domains = await domainBlock.getCategoryDomains('adblock_strict', true);
    log.debug('getCategoryDomains adblock_strict', domains);
    log.debug('getCategoryDomains porn_bf', await domainBlock.getCategoryDomains('porn_bf', true))
    expect(domains).to.be.not.empty;
  });

  it('should get cloudcache', async() => {
    await cloudcache.enableCache('bf:app.porn_bf');
    let cacheItem = cloudcache.getCacheItem('bf:app.porn_bf');
    await cacheItem.download(false);
    log.debug('cloudcache content', cacheItem.localCachePath);
    const content = await cacheItem.getLocalCacheContent()
    expect(content).to.be.not.empty;
  });
});
