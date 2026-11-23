/*    Copyright 2026 Firewalla Inc.
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

const chai = require('chai');
const expect = chai.expect;

const AlarmManager2 = require('../alarm/AlarmManager2.js');
const HostTool = require('../net2/HostTool.js');
const sysManager = require('../net2/SysManager.js');

const am2 = new AlarmManager2();

const LAN_IP = '192.168.10.1';
const LAN_MAC = '20:6D:31:00:00:01';
const WAN_IP = '10.0.0.2';
const WAN_MAC = '20:6D:31:00:00:02';
const WG_IP = '10.6.6.1';
const WG_MAC = '02:01:22:22:22:22';
const MACS = { [LAN_IP]: LAN_MAC, [WAN_IP]: WAN_MAC, [WG_IP]: WG_MAC };

function scanAlarm(ip) {
  return { type: 'ALARM_BRO_NOTICE', 'p.noticeType': 'Scan::Port_Scan', 'p.device.ip': ip };
}

describe('enrichDeviceInfo on the box itself', function () {
  this.timeout(10000);

  const origs = {};

  before(() => {
    for (const name of ['isMyIP', 'isMyIP6', 'myMACViaIP4', 'myMACViaIP6'])
      origs[name] = sysManager[name];
    origs.getMACEntry = HostTool.prototype.getMACEntry;
    origs.getSelfMacVendor = AlarmManager2.prototype.getSelfMacVendor;

    sysManager.isMyIP = ip => ip in MACS;
    sysManager.isMyIP6 = () => false;
    sysManager.myMACViaIP4 = ip => MACS[ip];
    sysManager.myMACViaIP6 = () => undefined;
    // only the LAN port is listed as a device
    HostTool.prototype.getMACEntry = async mac => mac === LAN_MAC ? { mac } : null;
    AlarmManager2.prototype.getSelfMacVendor = async () => 'FIREWALLA INC';
  });

  after(() => {
    for (const name of ['isMyIP', 'isMyIP6', 'myMACViaIP4', 'myMACViaIP6'])
      sysManager[name] = origs[name];
    HostTool.prototype.getMACEntry = origs.getMACEntry;
    AlarmManager2.prototype.getSelfMacVendor = origs.getSelfMacVendor;
  });

  it('fills the MAC of a port listed as a device', async () => {
    const alarm = await am2.enrichDeviceInfo(scanAlarm(LAN_IP));
    expect(alarm['p.device.name']).to.equal('Firewalla');
    expect(alarm['p.device.mac']).to.equal(LAN_MAC);
    expect(alarm['p.device.id']).to.equal(LAN_MAC);
    expect(alarm['p.device.macVendor']).to.equal('FIREWALLA INC');
  });

  for (const [desc, ip] of [['a VPN interface placeholder MAC', WG_IP], ['a WAN port MAC', WAN_IP]]) {
    it(`leaves out ${desc}, which is not listed as a device`, async () => {
      const alarm = await am2.enrichDeviceInfo(scanAlarm(ip));
      expect(alarm['p.device.name']).to.equal('Firewalla');
      expect(alarm['p.device.ip']).to.equal(ip);
      expect(alarm).to.not.have.property('p.device.mac');
      expect(alarm).to.not.have.property('p.device.id');
      expect(alarm).to.not.have.property('p.device.macVendor');
    });
  }

  it('drops a WAN port MAC the caller filled in', async () => {
    const alarm = await am2.enrichDeviceInfo(Object.assign(scanAlarm(WAN_IP), { 'p.device.mac': WAN_MAC }));
    expect(alarm).to.not.have.property('p.device.mac');
  });
});
