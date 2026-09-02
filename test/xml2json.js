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
const proxyquire = require('proxyquire').noPreserveCache();

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

const soapString = String.raw`<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
      <NewExternalPort>2049</NewExternalPort>
    </u:AddPortMapping>
  </s:Body>
</s:Envelope>`

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

  it('should output without root if set root to false', async() => {
    const result = await xml2json.parse(xmlString, {root: false})
    expect(result.root).to.be.empty
    expect(result.key).to.equal('foo')
    expect(result.value).to.equal('bar')
  });

  it('should strip namespace away from key', async() => {
    const result = await xml2json.parse(soapString)
    expect(result.Envelope).to.be.an('object')
    expect(result.Envelope.Body).to.be.an('object')
    expect(result.Envelope.Body.AddPortMapping).to.be.an('object')
    expect(result.Envelope.Body.AddPortMapping.NewExternalPort).to.equal('2049')
  });

  it('should throw on malformat XML', async() => {
    const result = await xml2json.parse(malXML)
    expect(result).to.be.empty
  });
})


describe('xml2json output bounds', () => {
  const EventEmitter = require('events');

  function createFakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = {
      write: () => {},
      end: () => {}
    };
    child.killCalled = false;
    child.kill = () => {
      child.killCalled = true;
    };
    return child;
  }

  function loadWithChild(child) {
    return proxyquire('../extension/xml2json/xml2json.js', {
      'child_process': {
        spawn: () => child
      }
    });
  }

  it('rejects and kills the child when stdout exceeds 1 MiB', async () => {
    const child = createFakeChild();
    const parser = loadWithChild(child);

    const promise = parser.parse('<root/>');
    child.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1));

    let error;
    try {
      await promise;
    } catch (err) {
      error = err;
    }

    expect(error).to.be.an('error');
    expect(error.message).to.equal('xml2json output exceeds maximum size of 1048576 bytes');
    expect(child.killCalled).to.equal(true);
  });

  it('does not reject output at the 1 MiB boundary', async () => {
    const child = createFakeChild();
    const parser = loadWithChild(child);

    const jsonPrefix = '{"root":{"value":"';
    const jsonSuffix = '"}}';
    const valueSize = 1024 * 1024 - Buffer.byteLength(jsonPrefix) - Buffer.byteLength(jsonSuffix);
    const output = jsonPrefix + 'x'.repeat(valueSize) + jsonSuffix;

    const promise = parser.parse('<root/>');
    child.stdout.emit('data', Buffer.from(output));
    child.stdout.emit('close');

    const result = await promise;

    expect(result.root.value).to.have.length(valueSize);
    expect(child.killCalled).to.equal(true);
  });

  it('ignores stdout after the output limit has already rejected the parse', async () => {
    const child = createFakeChild();
    const parser = loadWithChild(child);

    const promise = parser.parse('<root/>');
    child.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1));
    child.stdout.emit('data', Buffer.from('{"unexpected":"result"}'));
    child.stdout.emit('close');

    let error;
    try {
      await promise;
    } catch (err) {
      error = err;
    }

    expect(error).to.be.an('error');
    expect(error.message).to.equal('xml2json output exceeds maximum size of 1048576 bytes');
  });
});
