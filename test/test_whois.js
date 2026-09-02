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

'use strict';

const net = require('net');
const chai = require('chai');
const expect = chai.expect;

const whoisClient = require('../lib/whois');

describe('WHOIS response size limit', function () {
  this.timeout(5000);

  let server;
  let port;
  let connectionClosed;

  afterEach((done) => {
    if (server) {
      server.close(done);
      server = null;
    } else {
      done();
    }
  });

  function listen(response) {
    return new Promise((resolve, reject) => {
      server = net.createServer(socket => {
        connectionClosed = new Promise(resolve => socket.once('close', resolve));
        socket.on('data', () => {});
        socket.end(response);
      });

      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  }

  it('rejects and closes the connection when the response exceeds 1 MiB', async () => {
    await listen('x'.repeat(1024 * 1024 + 1));

    let error;
    try {
      await whoisClient.lookup('example.com', {
        host: '127.0.0.1',
        port,
        raw: true,
      });
    } catch (err) {
      error = err;
    }

    expect(error).to.be.an('error');
    expect(error.message).to.equal('WHOIS response exceeds maximum size of 1048576 bytes');
    await connectionClosed;
  });

  it('still accepts responses at or below the limit', async () => {
    const response = 'x'.repeat(1024 * 1024);
    await listen(response);

    const result = await whoisClient.lookup('example.com', {
      host: '127.0.0.1',
      port,
      raw: true,
    });

    expect(result).to.equal(response);
  });
});
