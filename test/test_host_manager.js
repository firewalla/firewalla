/*    Copyright 2016-2025 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename)
const loggerManager = require('../net2/LoggerManager.js')
const MessageBus = require('../net2/MessageBus.js');
const messageBus = new MessageBus('info')
const fireRouter = require('../net2/FireRouter.js');
const sysManager = require('../net2/SysManager.js');
const TagManager = require('../net2/TagManager.js');
const Host = require('../net2/Host.js');
const Policy = require('../alarm/Policy.js');
const PolicyManager2 = require('../alarm/PolicyManager2.js');
const policyManager2 = new PolicyManager2();
const Exception = require('../alarm/Exception.js');
const ExceptionManager = require('../alarm/ExceptionManager.js');
const exceptionManager = new ExceptionManager();
const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();

describe('test filter policy rules', function(){
  let host, tag, intf, policyHost, policyTag, policyIntf, exceptionHost, exceptionIntf
  const policies = []
  const exceptions = []
  this.timeout(10000);

  before(async () => {
    await fireRouter.waitTillReady()
    await sysManager.updateAsync()
    host = new Host({ mac: 'AA:BB:CC:DD:EE:FF', lastActiveTimestamp: Date.now() })
    await host.save();
    ({ policy: policyHost } = await policyManager2.checkAndSaveAsync(new Policy({
      type: 'ip',
      action: 'block',
      scope: [host.getGUID()],
      target: '1.2.3.4'
    })));
    tag = await TagManager.createTag('test', {});
    ({ policy: policyTag } = await policyManager2.checkAndSaveAsync(new Policy({
      type: 'ip',
      action: 'block',
      tag: [`tag:${tag.getUniqueId()}`],
      target: '1.2.3.4'
    })));
    intf = sysManager.getMonitoringInterfaces()[0];
    ({ policy: policyIntf } = await policyManager2.checkAndSaveAsync(new Policy({
      type: 'ip',
      action: 'block',
      tag: [`intf:${intf.uuid}`],
      target: '1.2.3.4'
    })));
    policies.push(policyHost, policyTag, policyIntf);
    ({ exception: exceptionHost } = await exceptionManager.checkAndSave(new Exception({
      type: 'ALARM_LARGE_UPLOAD',
      'p.device.mac': host.getGUID(),
    })));
    ({ exception: exceptionIntf } = await exceptionManager.checkAndSave(new Exception({
      type: 'ALARM_LARGE_UPLOAD',
      'p.intf.id': intf.uuid,
    })));
    exceptions.push(exceptionHost, exceptionIntf)
    log.info('policies', policies.map(p=>p.pid), 'exceptions', exceptions.map(e=>e.eid))
  })

  it('should list all rules', async() => {
    let initData = await hostManager.toJson()

    expect(policies.every(p => initData.policyRules.some(r => r.pid == p.pid)),
      `expected ${policies.map(p => p.pid)} to be in ${initData.policyRules.map(r => r.pid)}`).to.be.true
    expect(exceptions.every(e => initData.exceptionRules.some(r => r.eid == e.eid)),
      `expected ${exceptions.map(e => e.eid)} to be in ${initData.exceptionRules.map(r => r.eid)}`).to.be.true
  })

  it('should filter rules by host active timestamp', async() => {
    host.o.lastActiveTimestamp = Date.now()/1000 - 60 * 60 * 24 * 7 * 5
    await host.save('lastActiveTimestamp')

    let initData = await hostManager.toJson({forceReload: true})

    expect(initData.policyRules.some(r => r.pid == policyHost.pid),
      `expected ${policyHost.pid} to not be in ${initData.policyRules.map(r => r.pid)}`).to.be.false
    expect(initData.exceptionRules.some(r => r.eid == exceptionHost.eid),
      `expected ${exceptionHost.eid} to not be in ${initData.exceptionRules.map(r => r.eid)}`).to.be.false

    initData = await hostManager.toJson({ includeInactiveHosts: true, forceReload: true })

    expect(initData.policyRules.some(r => r.pid == policyHost.pid)).to.be.true
    expect(initData.exceptionRules.some(r => r.eid == exceptionHost.eid)).to.be.true
  })

  it('should filter rules by host, intf, and tag', async() => {
    policyHost.scope = ['AA:AA:AA:AA:AA:AA']
    await policyManager2.updatePolicyAsync(policyHost)
    policyTag.tag = ['tag:AA']
    await policyManager2.updatePolicyAsync(policyTag)
    policyIntf.tag = ['intf:AA']
    await policyManager2.updatePolicyAsync(policyIntf)
    exceptionHost['p.device.mac'] = 'AA:AA:AA:AA:AA:AA'
    await exceptionManager.updateException(exceptionHost)
    exceptionIntf['p.intf.id'] = 'AA'
    await exceptionManager.updateException(exceptionIntf)
    let initData = await hostManager.toJson({includeInactiveHosts: true})

    expect(policies.every(p => initData.policyRules.some(r => r.pid == p.pid)),
      `expected ${policies.map(p=>p.pid)} to not be in ${initData.policyRules.map(r=>r.pid)}`).to.be.false
    expect(exceptions.every(e => initData.exceptionRules.some(r => r.eid == e.eid)),
      `expected ${exceptions.map(e=>e.eid)} to not be in ${initData.exceptionRules.map(r=>r.eid)}`).to.be.false
  })

  after(async () => {
    for (const p of policies) {
      await policyManager2.disableAndDeletePolicy(p.pid)
    }
    for (const e of exceptions) {
      await exceptionManager.deleteException(e.eid)
    }
    await TagManager.removeTag(tag.getUniqueId(), tag.getTagName())
    messageBus.publish("DiscoveryEvent", "Device:Delete", host.getGUID(), {});
    await host.destroy()
  })
})

describe('test ap assets', function(){
    this.timeout(3000);

    it('should enrich ap host ipv4', async() => {
        const hosts = [{"ip":"192.168.20.211","ipv6":[],"mac":"AA:BB:CC:DD:EE:FF"},{"ip":"192.168.20.122","ipv6":[],"mac":"AA:11:CC:22:EE:33"}];
        const assets = {"AA:BB:CC:DD:EE:FF":{"mac":"AA:BB:CC:DD:EE:FF","name":"Office","model":"fwap-F",
            "addrs":{"br-lan1":{"ip4":"192.168.20.211","mac":"20:6D:31:61:01:96"},"br-lan0":{"ip4":"192.168.10.137","mac":"20:6D:31:61:01:96"}}}};
        hostManager._enrichApInfo(hosts, assets);
        expect(hosts[0].ip).to.equal('192.168.10.137');

    });

});
