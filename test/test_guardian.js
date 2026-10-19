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
  let orig;

  beforeEach(async () => {
    orig = await rclient.smembersAsync(key);
    await rclient.unlinkAsync(key);
    await rclient.saddAsync(key, 'staleEid');
  });

  afterEach(async () => {
    await rclient.unlinkAsync(key);
    if (orig.length) await rclient.saddAsync(key, orig);
  });

  const data = (access) => ({ mobileAccess: _.mapValues(access, profileId => ({ profileId })) });
  const blacklist = async () => (await rclient.smembersAsync(key)).sort();

  it('replaces blacklist with readonly_access eids only', async () => {
    await guardian.syncEidBlacklist(data({ eidFull: 'full_access', eidLimited: 'limited_access', eidRo: 'readonly_access' }));
    expect(await blacklist()).to.deep.equal(['eidRo']);
  });

  it('removes eid upgraded from readonly_access to full_access', async () => {
    await guardian.syncEidBlacklist(data({ eidRo: 'readonly_access' }));
    await guardian.syncEidBlacklist(data({ eidRo: 'full_access' }));
    expect(await blacklist()).to.be.empty;
  });

  it('removes eid deleted from msp', async () => {
    await guardian.syncEidBlacklist(data({ eidRo: 'readonly_access', eidRo2: 'readonly_access' }));
    await guardian.syncEidBlacklist(data({ eidRo2: 'readonly_access' }));
    expect(await blacklist()).to.deep.equal(['eidRo2']);
  });

  it('keeps blacklist as is without mobileAccess', async () => {
    await guardian.syncEidBlacklist(data({ eidRo: 'readonly_access' }));
    await guardian.syncEidBlacklist({ targetlists: [] });
    await guardian.syncEidBlacklist(null);
    expect(await blacklist()).to.deep.equal(['eidRo']);
  });

  it('removes eid after an update without mobileAccess', async () => {
    await guardian.syncEidBlacklist(data({ eidRo: 'readonly_access' }));
    await guardian.syncEidBlacklist({ targetlists: [] });
    await guardian.syncEidBlacklist(data({ eidRo: 'limited_access' }));
    expect(await blacklist()).to.be.empty;
  });
});
