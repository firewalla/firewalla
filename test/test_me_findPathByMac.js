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
'use strict';

const chai = require('chai');
const expect = chai.expect;

const { findPathByMac } = require('../api/routes/meTopology.js');
const netTop = require('./test_data/net_top.json');

describe('me.findPathByMac', () => {
  const tree = netTop.info.tree;

  describe('resolve path for 192.168.203.249', () => {
    // 192.168.203.249 => iPhone, mac 0A:3D:FB:40:E7:CB
    const targetMac = '0A:3D:FB:40:E7:CB';

    it('returns the full path from root box to the target device', () => {
      const path = findPathByMac(tree, targetMac);
      expect(path).to.be.an('array');
      console.log('Found path for device', targetMac, ':', path.map(n => n.mac));

      const macs = path.map(n => n.mac);
      expect(macs).to.deep.equal([
        '20:6D:31:51:00:08', // box
        '20:6D:31:63:30:C4', // Charlie AP (direct wired child of box)
        '0A:3D:FB:40:E7:CB',  // iPhone (target, wirelessly associated to Charlie AP)
      ]);
    });

    it('has the target device (with matching ip) as the last hop', () => {
      const path = findPathByMac(tree, targetMac);
      const last = path[path.length - 1];
      expect(last.mac).to.equal(targetMac);
      expect(last.ip).to.equal('192.168.203.249');
      expect(last.type).to.equal('device');
    });

    it('starts the path at the root box', () => {
      const path = findPathByMac(tree, targetMac);
      expect(path[0].type).to.equal('box');
      expect(path[0].mac).to.equal('20:6D:31:51:00:08');
    });

    it('reports the expected hop types in order', () => {
      const path = findPathByMac(tree, targetMac);
      expect(path.map(n => n.type)).to.deep.equal(['box', 'ap', 'device']);
    });
  });

  describe('resolve path for 192.168.201.82', () => {
    // 192.168.201.82 => iPhone behind the switch chain, mac 7A:23:62:47:F8:BD
    const targetMac = '7A:23:62:47:F8:BD';

    it('returns the full multi-hop path through the switch chain to the mesh AP', () => {
      const path = findPathByMac(tree, targetMac);
      expect(path).to.be.an('array');

      const macs = path.map(n => n.mac);
      expect(macs).to.deep.equal([
        '20:6D:31:51:00:08', // box
        '20:6D:31:A0:01:04', // Switch X 4
        '20:6D:31:A6:02:26', // SwitchSE
        '20:6D:31:71:01:14', // Sun Flower AP
        '20:6D:31:71:01:98', // Turtle AP (wireless mesh backhaul)
        '7A:23:62:47:F8:BD',  // iPhone (target, wirelessly associated to Turtle AP)
      ]);
    });

    it('has the target device (with matching ip) as the last hop', () => {
      const path = findPathByMac(tree, targetMac);
      const last = path[path.length - 1];
      expect(last.mac).to.equal(targetMac);
      expect(last.ip).to.equal('192.168.201.82');
      expect(last.type).to.equal('device');
    });

    it('reports the expected hop types in order', () => {
      const path = findPathByMac(tree, targetMac);
      expect(path.map(n => n.type)).to.deep.equal(['box', 'switch', 'switch', 'ap', 'ap', 'device']);
    });
  });

  describe('matching behavior', () => {
    it('matches case-insensitively', () => {
      const path = findPathByMac(tree, '0a:3d:fb:40:e7:cb');
      expect(path).to.be.an('array');
      expect(path[path.length - 1].mac).to.equal('0A:3D:FB:40:E7:CB');
    });

    it('returns null when the mac is not present', () => {
      expect(findPathByMac(tree, 'FF:FF:FF:FF:FF:FF')).to.be.null;
    });

    it('returns null for empty / missing input', () => {
      expect(findPathByMac(null, '0A:3D:FB:40:E7:CB')).to.be.null;
      expect(findPathByMac([], '0A:3D:FB:40:E7:CB')).to.be.null;
    });
  });
});
