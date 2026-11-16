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

const fireRouter = require('../net2/FireRouter.js');
const LiveStatsPlugin = require('../sensor/LiveStatsPlugin.js');

// hostapd on a box with two ssids sharing one 5g radio. STATUS answers for the whole radio, so the
// same bss list comes back no matter which of the two interfaces is queried.
const HOSTAPD_MULTI_BSS = `state=ENABLED
phy=phy1
freq=5180
hw_mode=a
country_code=US
channel=36
ieee80211ax=1
beacon_int=100
max_txpower=23
bss[0]=wlan5g_2be4fa
bssid[0]=20:6d:31:80:01:4e
ssid[0]=normal
num_sta[0]=0
bss[1]=wlan5g_7e4c3d
bssid[1]=26:6d:31:80:01:4e
ssid[1]=yj
num_sta[1]=1
`;

// hostapd on a wifi-sd box, where the radio can only ever hold one ap
const HOSTAPD_SINGLE_BSS = `state=ENABLED
phy=phy2
freq=5180
channel=36
ieee80211ac=1
max_txpower=23
bss[0]=wlan1
bssid[0]=20:6d:31:ee:39:4c
ssid[0]=VPurple-test
num_sta[0]=0
`;

// wpa_supplicant on a wifi-WAN that is associated
const WPA_STA_CONNECTED = `bssid=d4:53:2a:72:cd:00
freq=5180
ssid=XIAOMI_5G
id=0
mode=station
wifi_generation=5
key_mgmt=WPA2-PSK
wpa_state=COMPLETED
address=20:6d:31:ee:3c:7e
ieee80211ac=1
`;

// wpa_supplicant on a wifi-WAN that is up but not associated - no ssid, no freq
const WPA_STA_IDLE = `wpa_state=INACTIVE
p2p_device_address=20:6d:31:80:01:4c
address=20:6d:31:80:01:4c
uuid=fa2de223-f6b4-5f10-89f5-b862b5fc2ce9
`;

describe('LiveStatsPlugin wlan throughput', function() {
  this.timeout(3000);

  before(() => {
    this.plugin = new LiveStatsPlugin({});
    this.plugin.getIntfThroughput = async (name) => ({ name, tx: 100, rx: 200 });
    // pretend every wlan* nic exists locally
    this.plugin.validIntfName = async (name) => /^wlan/.test(name);
  });

  describe('parseWpaStatus (hostapd / ap)', () => {
    it('picks the ssid of the queried interface, not the last one on the radio', () => {
      expect(this.plugin.parseWpaStatus(HOSTAPD_MULTI_BSS, 'wlan5g_2be4fa'))
        .to.eql({ ssid: 'normal', band: '5g' });
      expect(this.plugin.parseWpaStatus(HOSTAPD_MULTI_BSS, 'wlan5g_7e4c3d'))
        .to.eql({ ssid: 'yj', band: '5g' });
    });

    it('handles a radio with a single bss', () => {
      expect(this.plugin.parseWpaStatus(HOSTAPD_SINGLE_BSS, 'wlan1'))
        .to.eql({ ssid: 'VPurple-test', band: '5g' });
    });

    it('returns a null ssid when the interface is absent from the bss list', () => {
      expect(this.plugin.parseWpaStatus(HOSTAPD_MULTI_BSS, 'wlan24g_7e4c3d'))
        .to.eql({ ssid: null, band: '5g' });
    });
  });

  describe('parseWpaStatus (wpa_supplicant / wifi-WAN)', () => {
    it('reads the flat ssid of an associated station', () => {
      expect(this.plugin.parseWpaStatus(WPA_STA_CONNECTED, 'wlan0'))
        .to.eql({ ssid: 'XIAOMI_5G', band: '5g' });
    });

    it('yields nulls when the station is not associated', () => {
      expect(this.plugin.parseWpaStatus(WPA_STA_IDLE, 'wlan0')).to.eql({ ssid: null, band: null });
    });

    it('returns nulls on empty output, e.g. a failed ctrl socket call', () => {
      expect(this.plugin.parseWpaStatus('', 'wlan0')).to.eql({ ssid: null, band: null });
    });

    it('decodes an ssid escaped by hostap', () => {
      expect(this.plugin.parseWpaStatus('ssid=\\xe5\\xae\\xb6\\xe9\\x87\\x8c-5G\nfreq=2437\n', 'wlan0'))
        .to.eql({ ssid: '家里-5G', band: '2g' });
    });
  });

  describe('parseWpaStatus band mapping', () => {
    it('maps each band, and yields null for a frequency it does not know', () => {
      expect(this.plugin.parseWpaStatus('ssid=a\nfreq=2437\n', 'x').band).to.equal('2g');
      expect(this.plugin.parseWpaStatus('ssid=a\nfreq=5180\n', 'x').band).to.equal('5g');
      expect(this.plugin.parseWpaStatus('ssid=a\nfreq=6215\n', 'x').band).to.equal('6g');
      expect(this.plugin.parseWpaStatus('ssid=a\nfreq=900\n',  'x').band).to.equal(null);
    });
  });

  describe('getWlanIntfs', () => {
    it('reads the role off the socket path, keeping only stations FireRouter calls WAN', async () => {
      this.plugin.listCtrlSockets = async () => ([
        '/home/pi/.router/run/hostapd/wlan24g_7e4c3d',
        '/home/pi/.router/run/hostapd/wlan5g_2be4fa',
        '/home/pi/.router/run/wpa_supplicant/wlan0/wlan0',
        '/home/pi/.router/run/wpa_supplicant/wlan_ap_scan/wlan_ap_scan', // runs wpa_supplicant, not a WAN
      ]);
      fireRouter.getWanIntfNames = () => ['eth1', 'wlan0'];

      expect(await this.plugin.getWlanIntfs()).to.eql([
        { name: 'wlan24g_7e4c3d', role: 'ap' },
        { name: 'wlan5g_2be4fa',  role: 'ap' },
        { name: 'wlan0',          role: 'wan' },
      ]);
    });

    it('drops a station that is configured but not currently a WAN', async () => {
      this.plugin.listCtrlSockets = async () => (['/home/pi/.router/run/wpa_supplicant/wlan0/wlan0']);
      fireRouter.getWanIntfNames = () => ['eth1'];

      expect(await this.plugin.getWlanIntfs()).to.eql([]);
    });

    it('returns empty on a box with no wifi', async () => {
      this.plugin.listCtrlSockets = async () => ([]);
      fireRouter.getWanIntfNames = () => ['eth0'];

      expect(await this.plugin.getWlanIntfs()).to.eql([]);
    });

    it('keeps the ap interfaces before the router config is loaded', async () => {
      this.plugin.listCtrlSockets = async () => ([
        '/home/pi/.router/run/hostapd/wlan1',
        '/home/pi/.router/run/wpa_supplicant/wlan0/wlan0',
      ]);
      fireRouter.getWanIntfNames = () => null; // wanIntfNames starts out null

      expect(await this.plugin.getWlanIntfs()).to.eql([{ name: 'wlan1', role: 'ap' }]);
    });
  });

  describe('getWlanThroughput', () => {
    it('reports ap and wifi-WAN interfaces with their ssid, band and rate', async () => {
      this.plugin.getWlanIntfs = async () => ([
        { name: 'wlan1', role: 'ap' },
        { name: 'wlan0', role: 'wan' },
      ]);
      this.plugin.getWlanIdentity = async (intf) => intf.name == 'wlan1'
        ? { ssid: 'VPurple-test', band: '5g' }
        : { ssid: 'XIAOMI_5G', band: '2g' };

      expect(await this.plugin.getWlanThroughput()).to.eql([
        { name: 'wlan1', target: 'wlan1', type: 'wlanIntf', role: 'ap',  ssid: 'VPurple-test', band: '5g', tx: 100, rx: 200 },
        { name: 'wlan0', target: 'wlan0', type: 'wlanIntf', role: 'wan', ssid: 'XIAOMI_5G',    band: '2g', tx: 100, rx: 200 },
      ]);
    });

    it('still reports throughput when the ctrl socket gives no ssid', async () => {
      this.plugin.getWlanIntfs = async () => ([{ name: 'wlan0', role: 'wan' }]);
      this.plugin.getWlanIdentity = async () => ({ ssid: null, band: null });

      expect(await this.plugin.getWlanThroughput()).to.eql([
        { name: 'wlan0', target: 'wlan0', type: 'wlanIntf', role: 'wan', ssid: null, band: null, tx: 100, rx: 200 },
      ]);
    });
  });
});
