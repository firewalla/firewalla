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

const LiveStatsPlugin = require('../sensor/LiveStatsPlugin.js');

describe('LiveStatsPlugin asset liveStats', function () {
  before(() => {
    this.plugin = new LiveStatsPlugin({});
  });

  it('formatAPThroughput returns empty arrays when info is missing', () => {
    expect(this.plugin.formatAPThroughput(null)).to.deep.equal({ ports: [], bands: [] });
    expect(this.plugin.formatAPThroughput({})).to.deep.equal({ ports: [], bands: [] });
  });

  it('formatAPThroughput splits ether into ports and wifi into bands, and attaches uplink to 6g', () => {
    const info = JSON.parse(`{
      "uplink": { "bssid": "20:6D:31:AD:12:34", "rssi": -54 },
      "ports": {
        "wifi2": {
          "intf": "wifi2", "type": "wifi", "ts": 1708001567450,
          "rxRate": 4975, "txRate": 11136, "txBytes": 3506524658, "rxBytes": 4053417092,
          "band": "6g"
        },
        "wifi0": {
          "intf": "wifi0", "type": "wifi", "ts": 1708001567446,
          "rxRate": 0, "txRate": 0, "txBytes": 229385342, "rxBytes": 11138253,
          "band": "2g"
        },
        "wifi1": {
          "intf": "wifi1", "type": "wifi", "ts": 1708001567448,
          "rxRate": 0, "txRate": 0, "txBytes": 18409, "rxBytes": 69694,
          "band": "5g"
        },
        "eth0": {
          "intf": "eth0", "type": "ether", "ts": 1708001567420,
          "rxRate": 2249, "txRate": 4164, "txBytes": 328116739, "rxBytes": 41181107,
          "linkSpeed": 2500, "linkState": "forwarding", "connected": true,
          "txBcast": 539924, "rxBcast": 1226, "txMcast": 185544, "rxMcast": 652
        },
        "eth1": {
          "intf": "eth1", "type": "ether", "ts": 1708001567425,
          "rxRate": 0, "txRate": 0, "txBytes": 0, "rxBytes": 0,
          "linkState": "disabled", "connected": false,
          "txBcast": 0, "rxBcast": 0, "txMcast": 0, "rxMcast": 0
        }
      }
    }`);

    const { ports, bands } = this.plugin.formatAPThroughput(info);

    expect(ports.map(p => p.intf)).to.deep.equal(['eth0', 'eth1']);
    expect(bands.map(b => b.intf)).to.deep.equal(['wifi2', 'wifi0', 'wifi1']);
    expect(bands.find(b => b.band === '6g').uplink).to.deep.equal(info.uplink);
    expect(bands.find(b => b.band === '2g').uplink).to.equal(undefined);
    expect(ports.every(p => p.uplink === undefined)).to.equal(true);
  });
});
