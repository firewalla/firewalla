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

const IntelManager = require('../net2/IntelManager.js');
const intelManager = new IntelManager();

describe('IntelManager.lookupDomain security category', () => {
  // whois is set so the lookup stays local
  const lookup = cc => intelManager.lookupDomain('phish.example.com', '203.0.113.70',
    {intel: {category: 'intel', cc, whois: {}}})

  it('should pick the same security category as flows', async () => {
    expect((await lookup('["attackpage","phishing"]')).cc).to.equal('phishing')
    expect((await lookup('["attackpage"]')).cc).to.be.undefined
    expect((await lookup('not json')).cc).to.be.undefined
  })
});
