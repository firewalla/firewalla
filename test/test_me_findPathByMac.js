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

  describe('resolve path for 203.0.113.2', () => {
    // 203.0.113.2 => Tablet-03, mac 02:00:00:03:00:03
    const targetMac = '02:00:00:03:00:03';

    it('returns the full path from root box to the target device', () => {
      const path = findPathByMac(tree, targetMac);
      expect(path).to.be.an('array');
      console.log('Found path for device', targetMac, ':', path.map(n => n.mac));

      const macs = path.map(n => n.mac);
      expect(macs).to.deep.equal([
        '02:00:00:00:00:01', // box
        '02:00:00:02:00:01', // AP-01 (direct wired child of box)
        '02:00:00:03:00:03', // Tablet-03 (target, wirelessly associated to AP-01)
      ]);
    });

    it('has the target device (with matching ip) as the last hop', () => {
      const path = findPathByMac(tree, targetMac);
      const last = path[path.length - 1];
      expect(last.mac).to.equal(targetMac);
      expect(last.ip).to.equal('203.0.113.2');
      expect(last.type).to.equal('device');
    });

    it('starts the path at the root box', () => {
      const path = findPathByMac(tree, targetMac);
      expect(path[0].type).to.equal('box');
      expect(path[0].mac).to.equal('02:00:00:00:00:01');
    });

    it('reports the expected hop types in order', () => {
      const path = findPathByMac(tree, targetMac);
      expect(path.map(n => n.type)).to.deep.equal(['box', 'ap', 'device']);
    });
  });

  describe('resolve path for 192.0.2.19', () => {
    // 192.0.2.19 => Camera-36 behind the switch chain, mac 02:00:00:03:00:24
    const targetMac = '02:00:00:03:00:24';

    it('returns the full multi-hop path through the switch chain to the mesh AP', () => {
      const path = findPathByMac(tree, targetMac);
      expect(path).to.be.an('array');

      const macs = path.map(n => n.mac);
      expect(macs).to.deep.equal([
        '02:00:00:00:00:01', // box
        '02:00:00:01:00:01', // Switch-01
        '02:00:00:01:00:02', // Switch-02
        '02:00:00:02:00:02', // AP-02
        '02:00:00:02:00:03', // AP-03 (wireless mesh backhaul)
        '02:00:00:03:00:24', // Camera-36 (target, wirelessly associated to AP-03)
      ]);
    });

    it('has the target device (with matching ip) as the last hop', () => {
      const path = findPathByMac(tree, targetMac);
      const last = path[path.length - 1];
      expect(last.mac).to.equal(targetMac);
      expect(last.ip).to.equal('192.0.2.19');
      expect(last.type).to.equal('device');
    });

    it('reports the expected hop types in order', () => {
      const path = findPathByMac(tree, targetMac);
      expect(path.map(n => n.type)).to.deep.equal(['box', 'switch', 'switch', 'ap', 'ap', 'device']);
    });
  });

  describe('matching behavior', () => {
    it('matches case-insensitively', () => {
      const path = findPathByMac(tree, '02:00:00:03:00:0c');
      expect(path).to.be.an('array');
      expect(path[path.length - 1].mac).to.equal('02:00:00:03:00:0C');
    });

    it('returns null when the mac is not present', () => {
      expect(findPathByMac(tree, 'FF:FF:FF:FF:FF:FF')).to.be.null;
    });

    it('returns null for empty / missing input', () => {
      expect(findPathByMac(null, '02:00:00:03:00:03')).to.be.null;
      expect(findPathByMac([], '02:00:00:03:00:03')).to.be.null;
    });
  });
});
