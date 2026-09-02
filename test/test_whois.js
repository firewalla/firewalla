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


  it('rejects on an expired deadline and closes the active connection', async () => {
    await new Promise((resolve, reject) => {
      server = net.createServer(socket => {
        connectionClosed = new Promise(resolve => socket.once('close', resolve));
        socket.on('data', () => {});
      });

      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });

    let error;
    try {
      await whoisClient.lookup('example.com', {
        host: '127.0.0.1',
        port,
        raw: true,
        deadline: Date.now() + 50,
      });
    } catch (err) {
      error = err;
    }

    expect(error).to.be.an('error');
    expect(error.message).to.equal('WHOIS lookup timed out');
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

const proxyquire = require('proxyquire').noPreserveCache();

describe('WHOIS referral handling', function () {
  it('limits referral depth instead of following an unbounded chain', async function () {
    const requests = [];
    const referralClient = {
      lookup: async (target, options) => {
        requests.push(options);
        const depth = requests.length - 1;
        return depth < 5 ? 'refer: whois' + (depth + 1) + '.example' : 'registrar: example';
      }
    };

    const Whois = proxyquire('../util/Whois.js', {
      '../lib/whois': referralClient,
      '../net2/logger.js': () => ({
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {}
      })
    });

    Whois.timeout = 5000;
    const result = await Whois.lookup('example.com');

    expect(result.refer).to.equal('whois4.example');
    expect(requests.map(request => request.host)).to.deep.equal([
      'whois.iana.org',
      'whois1.example',
      'whois2.example',
      'whois3.example'
    ]);
  });

  it('stops a referral cycle before issuing the repeated lookup', async function () {
    const hosts = [];
    const referralClient = {
      lookup: async (target, options) => {
        hosts.push(options.host);
        return options.host === 'whois.iana.org'
          ? 'refer: whois.example'
          : 'refer: whois.iana.org';
      }
    };

    const Whois = proxyquire('../util/Whois.js', {
      '../lib/whois': referralClient,
      '../net2/logger.js': () => ({
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {}
      })
    });

    const result = await Whois.lookup('example.com');

    expect(result.refer).to.equal('whois.iana.org');
    expect(hosts).to.deep.equal([
      'whois.iana.org',
      'whois.example'
    ]);
  });

  it('uses one end-to-end deadline for all referral lookups', async function () {
    const deadlines = [];
    const referralClient = {
      lookup: async (target, options) => {
        deadlines.push(options.deadline);
        await new Promise(resolve => setTimeout(resolve, 10));
        return options.host === 'whois.iana.org'
          ? 'refer: whois.example'
          : 'registrar: example';
      }
    };

    const Whois = proxyquire('../util/Whois.js', {
      '../lib/whois': referralClient,
      '../net2/logger.js': () => ({
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {}
      })
    });

    Whois.timeout = 50;
    const result = await Whois.lookup('example.com');

    expect(result.registrar).to.equal('example');
    expect(deadlines).to.have.length(2);
    expect(deadlines[0]).to.equal(deadlines[1]);
  });

  it('does not propagate the IANA fallback IP to referral hosts', async function () {
    const optionsSeen = [];
    const referralClient = {
      lookup: async (target, options) => {
        optionsSeen.push(Object.assign({}, options));
        return options.host === 'whois.iana.org'
          ? 'refer: whois.example'
          : 'registrar: example';
      }
    };

    const Whois = proxyquire('../util/Whois.js', {
      '../lib/whois': referralClient,
      '../net2/logger.js': () => ({
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {}
      })
    });

    await Whois.lookup('example.com');

    expect(optionsSeen).to.have.length(2);
    expect(optionsSeen[0].ip).to.equal('192.0.32.59');
    expect(optionsSeen[1].ip).to.not.exist;
  });
});
