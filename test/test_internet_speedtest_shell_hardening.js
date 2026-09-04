/*    Copyright 2026 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 */

'use strict';

const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

describe('InternetSpeedtestPlugin command construction', function () {
  let execFileCalls;
  let InternetSpeedtestPlugin;

  beforeEach(() => {
    execFileCalls = [];
    InternetSpeedtestPlugin = proxyquire('../sensor/InternetSpeedtestPlugin.js', {
      'child-process-promise': {
        execFile: (...args) => {
          execFileCalls.push(args);
          return Promise.resolve({
            stdout: JSON.stringify({
              user_info: {},
              servers: [{}]
            })
          });
        }
      }
    });
  });

  it('passes speedtest values as process arguments instead of shell source', async () => {
    const plugin = new InternetSpeedtestPlugin({});
    const result = await plugin.runSpeedTest(
      '192.0.2.10',
      ['192.0.2.1'],
      '12345',
      false,
      false,
      'ookla',
      {
        foo: '$(touch /tmp/unexpected)',
        bar: 'safe; touch /tmp/unexpected'
      },
      'TEST_ENV=$(touch /tmp/unexpected)'
    );

    expect(result.success).to.equal(true);
    expect(execFileCalls).to.have.lengthOf(1);

    const [binary, args, options] = execFileCalls[0];
    expect(binary).to.be.a('string');
    expect(args).to.include.members([
      '-b',
      '192.0.2.10',
      '--nameserver',
      '192.0.2.1',
      '-s',
      '12345',
      '--vendor',
      'ookla',
      '--foo',
      '$(touch /tmp/unexpected)',
      '--bar',
      'safe; touch /tmp/unexpected',
      '--json'
    ]);
    expect(options).to.have.property('timeout', 90000);
    expect(options.env.TEST_ENV).to.equal('$(touch /tmp/unexpected)');
  });

  it('preserves quoted and escaped whitespace and backslashes in legacy environment strings', async () => {
    const env = InternetSpeedtestPlugin._buildSpeedTestEnv(
      String.raw`HTTP_PROXY="proxy with spaces" TOKEN=a\ b SINGLE='a\b' DOUBLE="a\b" DOUBLE_NONSPECIAL="a\qb"`
    );

    expect(env.HTTP_PROXY).to.equal('proxy with spaces');
    expect(env.TOKEN).to.equal('a b');
    expect(env.SINGLE).to.equal('a\\b');
    expect(env.DOUBLE).to.equal('a\\b');
    expect(env.DOUBLE_NONSPECIAL).to.equal('a\\qb');
  });

  it('rejects unterminated legacy environment quoting', async () => {
    expect(() => InternetSpeedtestPlugin._buildSpeedTestEnv(
      'HTTP_PROXY="proxy with spaces'
    )).to.throw(/Invalid speedtest environment assignment/);
  });

  it('rejects malformed option names before executing', async () => {
    const plugin = new InternetSpeedtestPlugin({});

    const result = await plugin.runSpeedTest(
      null,
      null,
      null,
      false,
      false,
      'ookla',
      { 'bad;touch': 'x' }
    );

    expect(result.success).to.equal(false);
    expect(result.err).to.match(/Invalid speedtest option/);
    expect(execFileCalls).to.have.lengthOf(0);
  });

  it('rejects malformed server IDs before executing', async () => {
    const plugin = new InternetSpeedtestPlugin({});

    const result = await plugin.runSpeedTest(
      null,
      null,
      '123;touch',
      false,
      false,
      'ookla'
    );

    expect(result.success).to.equal(false);
    expect(result.err).to.match(/Invalid speedtest server ID/);
    expect(execFileCalls).to.have.lengthOf(0);
  });

  it('rejects malformed vendor values before executing', async () => {
    const plugin = new InternetSpeedtestPlugin({});

    const result = await plugin.runSpeedTest(
      null,
      null,
      null,
      false,
      false,
      'ookla;touch'
    );

    expect(result.success).to.equal(false);
    expect(result.err).to.match(/Invalid speedtest vendor/);
    expect(execFileCalls).to.have.lengthOf(0);
  });

  it('builds list-server arguments without shell interpretation', async () => {
    const plugin = new InternetSpeedtestPlugin({});
    await plugin.listAvailableServers(
      '192.0.2.10',
      ['192.0.2.1'],
      'ookla'
    );

    expect(execFileCalls).to.have.lengthOf(1);
    expect(execFileCalls[0][1]).to.eql([
      '-b',
      '192.0.2.10',
      '--nameserver',
      '192.0.2.1',
      '--vendor',
      'ookla',
      '-l',
      '--json'
    ]);
  });
});
