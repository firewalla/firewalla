/*    Copyright 2016-2026 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the GNU Affero General Public License, version 3.
 */

'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();

describe('NetworkMonitorSensor command execution', function() {
  let calls;
  let command;

  beforeEach(function() {
    calls = [];
    command = proxyquire('../util/NetworkMonitorCommand.js', {
      'child-process-promise': {
        execFile: async (file, args) => {
          calls.push({ file, args });
          if (file === 'sudo') return { stdout: '64 bytes from host: time=1.25 ms\n' };
          if (file === 'dig') return { stdout: ';; Query time: 7 msec\n' };
          return { stdout: '0.125000\n' };
        }
      }
    });
  });

  it('passes ping targets as literal arguments instead of shell commands', async function() {
    const target = '1.1.1.1; touch /tmp/network-monitor-injected';
    const result = await command.ping(target, 1, 1, 0);

    expect(calls).to.deep.equal([{
      file: 'sudo',
      args: ['ping', '-i', '1', '-c', '1', '-W', '1', '-4', '-n', target]
    }]);
    expect(result).to.deep.equal([1.25]);
  });

  it('passes DNS names and HTTP URLs as literal arguments', async function() {
    const dnsTarget = '8.8.8.8; touch /tmp/network-monitor-injected';
    const lookupName = 'example.com; touch /tmp/network-monitor-injected';
    const httpTarget = "https://example.com/'; touch /tmp/network-monitor-injected; #";

    const dnsResult = await command.dns(dnsTarget, null, 1, lookupName);
    const httpResult = await command.http(httpTarget, null);

    expect(calls[0]).to.deep.equal({
      file: 'dig',
      args: [`@${dnsTarget}`, '+tries=1', '+timeout=1', lookupName]
    });
    expect(calls[1]).to.deep.equal({
      file: 'curl',
      args: ['-s', '-k', '-m', '10', '-o', '/dev/null', '-w', '%{time_total}\n', '--', httpTarget]
    });
    expect(dnsResult).to.equal(7);
    expect(httpResult).to.equal(0.125);
  });
});
