/*    Copyright 2016-2026 Firewalla Inc.
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

const fwapc = require('../net2/fwapc.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const LiveStatsPlugin = require('../sensor/LiveStatsPlugin.js');

// `iw dev` output on a hostapd box: 2 broadcasting APs + a scan/sta interface + a wifi-WAN with an ssid
const IW_DEV_OUTPUT = `phy#1
\tInterface wlan5g_7e4c3d
\t\tifindex 51
\t\tssid yj
\t\ttype AP
\t\tchannel 36 (5180 MHz), width: 160 MHz, center1: 5250 MHz
\t\tmulticast TXQ:
\t\t\tqsz-byt\tqsz-pkt\tflows
\t\t\t0\t0\t287613
\tInterface wlan24g_7e4c3d
\t\tssid yj
\t\ttype AP
\t\tchannel 6 (2437 MHz), width: 20 MHz
\tInterface wlan_ap_scan
\t\ttype managed
\tInterface wlan0
\t\tssid HotelGuest
\t\ttype managed
`;

const ASSET = '20:6D:31:00:00:00';
const APS_FIXTURE = {
  wlan24g_7e4c3d: { intf: 'wlan24g_7e4c3d', ssid: 'yj',     band: '2g', mode: 'ap'  },
  wlan5g_7e4c3d:  { intf: 'wlan5g_7e4c3d',  ssid: 'yj',     band: '5g', mode: 'ap'  },
  wlan0:          { intf: 'wlan0',          ssid: '',       band: '2g', mode: 'sta' },
};

describe('LiveStatsPlugin wlan throughput', function() {
  this.timeout(3000);

  before(() => {
    this.plugin = new LiveStatsPlugin({});
    this.plugin.getIntfThroughput = async (name) => ({ name, tx: 100, rx: 200 });
    // pretend every wlan* nic exists locally
    this.plugin.validIntfName = async (name) => /^wlan/.test(name);
  });

  describe('parseWlanAps (hostapd / iw dev path)', () => {
    it('keeps AP-mode interfaces with ssid + band, drops sta/scan/wifi-WAN', () => {
      expect(this.plugin.parseWlanAps(IW_DEV_OUTPUT)).to.eql([
        { name: 'wlan5g_7e4c3d',  ssid: 'yj', band: '5g' },
        { name: 'wlan24g_7e4c3d', ssid: 'yj', band: '2g' },
      ]);
    });

    it('returns empty for output with no AP interfaces', () => {
      expect(this.plugin.parseWlanAps('phy#0\n\tInterface wlan0\n\t\ttype managed\n')).to.eql([]);
    });
  });

  describe('getApcWlanAps (integrated-AP / fwapc path)', () => {
    it('keeps local AP-mode VAPs and drops sta interfaces', async () => {
      fwapc.getAssetsStatus = async () => ({ [ASSET]: { aps: APS_FIXTURE } });

      expect(await this.plugin.getApcWlanAps()).to.eql([
        { name: 'wlan24g_7e4c3d', ssid: 'yj', band: '2g' },
        { name: 'wlan5g_7e4c3d',  ssid: 'yj', band: '5g' },
      ]);
    });

    it('counts a mesh-shared intf once and skips non-local (remote AP) intfs', async () => {
      fwapc.getAssetsStatus = async () => ({
        [ASSET]:             { aps: { wlan5g_7e4c3d: { intf: 'wlan5g_7e4c3d', ssid: 'yj', band: '5g', mode: 'ap' } } },
        'BB:BB:BB:BB:BB:BB': { aps: {
          wlan5g_7e4c3d: { intf: 'wlan5g_7e4c3d', ssid: 'yj',    band: '5g', mode: 'ap' }, // same ssid mesh -> same name
          remote6g:      { intf: 'remote6g',      ssid: 'guest', band: '6g', mode: 'ap' }, // not local
        } },
      });

      expect(await this.plugin.getApcWlanAps()).to.eql([
        { name: 'wlan5g_7e4c3d', ssid: 'yj', band: '5g' },
      ]);
    });

    it('returns empty when the controller yields no data', async () => {
      fwapc.getAssetsStatus = async () => null;
      expect(await this.plugin.getApcWlanAps()).to.eql([]);
    });
  });

  describe('getWlanThroughput (platform gating + /sys read)', () => {
    it('uses the fwapc path on integrated-AP platforms', async () => {
      platform.hasIntegratedAPAssets = async () => true;
      this.plugin.getApcWlanAps = async () => ([{ name: 'wlan5g_7e4c3d', ssid: 'yj', band: '5g' }]);
      this.plugin.getLocalWlanAps = async () => { throw new Error('iw path should not run'); };

      expect(await this.plugin.getWlanThroughput()).to.eql([
        { name: 'wlan5g_7e4c3d', target: 'wlan5g_7e4c3d', type: 'wlanIntf', ssid: 'yj', band: '5g', tx: 100, rx: 200 },
      ]);
    });

    it('uses the iw dev path on non-integrated platforms (purple / wifi sd)', async () => {
      platform.hasIntegratedAPAssets = async () => false;
      this.plugin.getLocalWlanAps = async () => ([{ name: 'wlan1', ssid: 'home', band: '5g' }]);
      this.plugin.getApcWlanAps = async () => { throw new Error('fwapc path should not run'); };

      expect(await this.plugin.getWlanThroughput()).to.eql([
        { name: 'wlan1', target: 'wlan1', type: 'wlanIntf', ssid: 'home', band: '5g', tx: 100, rx: 200 },
      ]);
    });
  });
});
