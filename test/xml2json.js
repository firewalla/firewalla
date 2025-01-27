/*    Copyright 2025 Firewalla Inc.
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

const xml2json = require('../extension/xml2json/xml2json.js')

const xmlString = String.raw`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<root>
  <key>foo</key>
  <value>bar</value>
  <nested>
    <item>a</item>
    <item><subitem>b</subitem></item>
    <item><subitem>c</subitem></item>
    <notitem>d</notitem>
  </nested>
</root>`

const malXML = String.raw`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<root>
  <key>foo</key>
  <value>bar</value>
</ro>`

describe('xml2json binary wrapper', () => {

  it('should parse XML correctly', async() => {
    const result = await xml2json.parse(xmlString)
    expect(result.root).to.be.an('object')
    expect(result.root.key).to.equal('foo')
    expect(result.root.value).to.equal('bar')
    expect(result.root.nested.item).to.be.an('array')
    expect(result.root.nested.item[0]).to.be.equal('a')
    expect(result.root.nested.item[2].subitem).to.equal('c')
    expect(result.root.nested.notitem).to.equal('d')
  });

  it('should throw on malformat XML', async() => {
    const result = await xml2json.parse(malXML)
    expect(result).to.be.empty
  });
})
