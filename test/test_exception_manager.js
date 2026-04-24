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
const { expect } = chai;

const Exception = require('../alarm/Exception.js');
const ExceptionManager = require('../alarm/ExceptionManager.js');
const exceptionManager = new ExceptionManager();
const platform = require('../platform/PlatformLoader.js').getPlatform();

describe('ExceptionManager capacity', function () {
  this.timeout(30000);

  const createdEids = [];

  after(async () => {
    for (const eid of createdEids) {
      try { await exceptionManager.deleteException(eid); } catch (e) { /* ignore */ }
    }
  });

  describe('platform.getExceptionCapacity', () => {
    it('should return a positive integer', () => {
      const cap = platform.getExceptionCapacity();
      expect(cap).to.be.a('number');
      expect(cap).to.be.greaterThan(0);
      expect(Number.isInteger(cap)).to.be.true;
    });
  });

  describe('loadExceptionsAsync pagination', () => {
    const N = 5;

    before(async () => {
      for (let i = 0; i < N; i++) {
        const e = new Exception({
          'p.dest.name': `capacity-test-${Date.now()}-${i}.example`,
          'reason': 'CAPACITY_TEST',
          'type': 'ALARM_INTEL',
        });
        const saved = await exceptionManager.saveExceptionAsync(e);
        createdEids.push(saved.eid);
      }
    });

    it('should return all exceptions when no options given', async () => {
      const all = await exceptionManager.loadExceptionsAsync();
      const found = all.filter(e => createdEids.includes(e.eid));
      expect(found.length).to.equal(N);
    });

    it('should respect options.number', async () => {
      const limited = await exceptionManager.loadExceptionsAsync({ number: 2 });
      expect(limited.length).to.equal(2);
    });

    it('should return results recent-first (highest numeric EID first)', async () => {
      const limited = await exceptionManager.loadExceptionsAsync({ number: N });
      const eids = limited.map(e => Number(e.eid));
      const sorted = [...eids].sort((a, b) => b - a);
      expect(eids).to.deep.equal(sorted);
      // Our freshly-created EIDs should be on top (they were the newest before the test)
      const topCreated = createdEids.map(Number).sort((a, b) => b - a);
      expect(eids.slice(0, N)).to.deep.equal(topCreated);
    });

    it('should page via options.offset + options.number', async () => {
      const page1 = await exceptionManager.loadExceptionsAsync({ offset: 0, number: 2 });
      const page2 = await exceptionManager.loadExceptionsAsync({ offset: 2, number: 2 });
      expect(page1.length).to.equal(2);
      expect(page2.length).to.equal(2);
      const page1Eids = page1.map(e => e.eid);
      const page2Eids = page2.map(e => e.eid);
      // No overlap between pages
      expect(page1Eids.some(id => page2Eids.includes(id))).to.be.false;
    });

  });

  describe('capacity cap', () => {
    const extraEids = [];
    const SMALL_CAP = 3;
    const FILL = 6;
    let origGetExceptionCapacity;

    before(async () => {
      origGetExceptionCapacity = platform.getExceptionCapacity;
      platform.getExceptionCapacity = () => SMALL_CAP;

      for (let i = 0; i < FILL; i++) {
        const e = new Exception({
          'p.dest.name': `cap-fill-${Date.now()}-${i}.example`,
          'reason': 'CAPACITY_TEST',
          'type': 'ALARM_INTEL',
        });
        const saved = await exceptionManager.saveExceptionAsync(e);
        extraEids.push(saved.eid);
        createdEids.push(saved.eid);
      }
    });

    after(() => {
      platform.getExceptionCapacity = origGetExceptionCapacity;
    });

    it('should cap unbounded load at platform.getExceptionCapacity()', async () => {
      const all = await exceptionManager.loadExceptionsAsync();
      expect(all.length).to.equal(SMALL_CAP);
    });

    it('should return the most recent entries when capped', async () => {
      const all = await exceptionManager.loadExceptionsAsync();
      const returnedEids = all.map(e => Number(e.eid));
      const expectedTop = extraEids.map(Number).sort((a, b) => b - a).slice(0, SMALL_CAP);
      expect(returnedEids).to.deep.equal(expectedTop);
    });

    it('should still allow options.number to override the cap', async () => {
      const all = await exceptionManager.loadExceptionsAsync({ number: FILL });
      expect(all.length).to.be.at.least(FILL);
    });
  });
});
