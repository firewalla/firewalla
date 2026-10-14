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
const rclient = require('../util/redis_manager').getRedisClient();
const Constants = require('../net2/Constants.js');
const Guardian = require('../sensor/Guardian.js');
const _ = require('lodash');

// daemon = false, so no socket connection or schedule is started
const guardian = new Guardian('test_eid_blacklist', {}, false);
const key = Constants.REDIS_KEY_EID_BLACKLIST;

describe('Test Guardian.syncEidBlacklist', function () {
  const origSadd = rclient.saddAsync, origSrem = rclient.sremAsync;
  let blacklist;

  beforeEach(() => {
    blacklist = new Set(['manualEid']);
    rclient.saddAsync = async (k, members) => { expect(k).to.equal(key); members.forEach(m => blacklist.add(m)); };
    rclient.sremAsync = async (k, members) => { expect(k).to.equal(key); members.forEach(m => blacklist.delete(m)); };
  });

  afterEach(() => {
    rclient.saddAsync = origSadd;
    rclient.sremAsync = origSrem;
  });

  const data = (access) => ({ mobileAccess: _.mapValues(access, profileId => ({ profileId })) });

  it('adds readonly eids only', async () => {
    await guardian.syncEidBlacklist(data({ eidFull: 'full_access', eidLimited: 'limited_access', eidRo: 'readonly' }), []);
    expect([...blacklist].sort()).to.deep.equal(['eidRo', 'manualEid']);
  });

  it('removes eid upgraded from readonly to full_access', async () => {
    blacklist.add('eidRo');
    await guardian.syncEidBlacklist(data({ eidRo: 'full_access' }), data({ eidRo: 'readonly' }));
    expect([...blacklist]).to.deep.equal(['manualEid']);
  });

  it('removes readonly eid deleted from msp', async () => {
    blacklist.add('eidRo');
    await guardian.syncEidBlacklist(data({ eidFull: 'full_access' }), data({ eidRo: 'readonly', eidFull: 'full_access' }));
    expect([...blacklist]).to.deep.equal(['manualEid']);
  });

  it('keeps manually added eids not readonly before', async () => {
    await guardian.syncEidBlacklist(data({ manualEid: 'full_access' }), data({ manualEid: 'full_access' }));
    expect([...blacklist]).to.deep.equal(['manualEid']);
  });

  it('keeps blacklist as is without mobileAccess', async () => {
    blacklist.add('eidRo');
    await guardian.syncEidBlacklist({ targetlists: [] }, data({ eidRo: 'readonly' }));
    await guardian.syncEidBlacklist(null, data({ eidRo: 'readonly' }));
    expect([...blacklist].sort()).to.deep.equal(['eidRo', 'manualEid']);
  });

  it('releases all readonly eids when msp is reset', async () => {
    blacklist.add('eidRo');
    await guardian.syncEidBlacklist({ mobileAccess: {} }, data({ eidRo: 'readonly' }));
    expect([...blacklist]).to.deep.equal(['manualEid']);
  });
});
