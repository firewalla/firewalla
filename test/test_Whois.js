'use strict';

const expect = require('chai').expect;
const proxyquire = require('proxyquire').noPreserveCache();
const EventEmitter = require('events');

describe('Whois referral handling', () => {
  it('limits referral depth instead of following an unbounded chain', async () => {
    const requests = [];
    const whoisClient = {
      lookup: async (target, options) => {
        requests.push(options.host);
        const depth = requests.length - 1;
        return depth < 5 ? `refer: whois${depth + 1}.example` : 'registrar: example';
      }
    };

    const Whois = proxyquire('../util/Whois.js', {
      '../lib/whois': whoisClient,
      '../net2/logger.js': () => ({
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {}
      })
    });

    Whois.timeout = 5000;
    const result = await Whois.lookup('example.com');

    expect(result.refer).to.equal('whois3.example');
    expect(requests).to.deep.equal([
      'whois.iana.org',
      'whois1.example',
      'whois2.example',
      'whois3.example'
    ]);
  });

  it('stops a referral cycle without issuing the repeated lookup', async () => {
    const requests = [];
    const whoisClient = {
      lookup: async (target, options) => {
        requests.push(options.host);
        return options.host === 'whois.iana.org'
          ? 'refer: whois.example'
          : 'refer: whois.iana.org';
      }
    };

    const Whois = proxyquire('../util/Whois.js', {
      '../lib/whois': whoisClient,
      '../net2/logger.js': () => ({
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {}
      })
    });

    Whois.timeout = 5000;
    const result = await Whois.lookup('example.com');

    expect(result.refer).to.equal('whois.iana.org');
    expect(requests).to.deep.equal([
      'whois.iana.org',
      'whois.example'
    ]);
  });

  it('propagates a shrinking timeout budget to each referral lookup', async () => {
    const timeouts = [];
    const whoisClient = {
      lookup: async (target, options) => {
        timeouts.push(options.timeout);
        await new Promise(resolve => setTimeout(resolve, 10));
        if (options.host === 'whois.iana.org')
          return 'refer: whois.example';
        return 'registrar: example';
      }
    };

    const Whois = proxyquire('../util/Whois.js', {
      '../lib/whois': whoisClient,
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
    expect(timeouts).to.have.length(2);
    expect(timeouts[0]).to.be.within(1, 50);
    expect(timeouts[1]).to.be.below(timeouts[0]);
  });
});

describe('lib/whois timeout handling', () => {
  it('destroys the socket and rejects when the lookup deadline expires', async () => {
    class FakeSocket extends EventEmitter {
      write() {}
      destroy() {
        this.destroyed = true;
        process.nextTick(() => this.emit('close', true));
      }
    }

    const socket = new FakeSocket();
    const net = {
      connect: (port, host, onConnect) => {
        process.nextTick(onConnect);
        return socket;
      }
    };

    const whoisClient = proxyquire('../lib/whois/index.js', {
      net,
      fs: {
        exists: () => {}
      },
      '../../net2/logger.js': () => ({
        error: () => {}
      })
    });

    let error;
    try {
      await whoisClient.lookup('example.com', {
        host: 'whois.example',
        timeout: 20,
        raw: true
      });
    } catch (err) {
      error = err;
    }

    expect(socket.destroyed).to.equal(true);
    expect(error).to.exist;
    expect(error.message).to.equal('WHOIS lookup timed out');
  });
});
