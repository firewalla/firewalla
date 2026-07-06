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

const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire').noPreserveCache().noCallThru();
const util = require('util');

function loadDNSMASQ(options = {}) {
  const commands = [];
  const redisOps = [];
  const timers = [];
  const logs = { info: [], warn: [], error: [], debug: [], verbose: [] };
  let nextTimerId = 1;

  const oldSetTimeout = global.setTimeout;
  const oldClearTimeout = global.clearTimeout;

  global.setTimeout = (fn, ms) => {
    const timer = { id: nextTimerId++, fn, ms, cleared: false };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer)
      timer.cleared = true;
  };

  const execResult = (cmd) => {
    if (cmd.includes('find ')) {
      return { stdout: `${options.md5 || 'abc123'}\n`, stderr: '' };
    } else if (cmd.includes('kill -RTMIN')) {
      if (options.killFails)
        throw new Error('kill failed');
      return { stdout: '', stderr: '' };
    } else if (cmd.includes('systemctl stop') || cmd.includes('systemctl restart')) {
      return { stdout: '', stderr: '' };
    }

    return { stdout: '', stderr: '' };
  };

  const exec = (cmd, cb) => {
    commands.push(cmd);
    try {
      const result = execResult(cmd);
      cb(null, result.stdout, result.stderr);
    } catch (err) {
      cb(err, '', err.message);
    }
  };
  exec[util.promisify.custom] = async (cmd) => {
    commands.push(cmd);
    return execResult(cmd);
  };

  const redisClient = {
    on: () => {},
    getAsync: async (key) => {
      redisOps.push(['get', key]);
      return options.md5Before;
    },
    setAsync: async (key, value) => {
      redisOps.push(['set', key, value]);
    },
    unlinkAsync: async () => {},
  };

  const fsStub = {
    constants: { F_OK: 0 },
    access: (path, cb) => cb(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    readdir: (path, cb) => cb(null, []),
    stat: (path, cb) => cb(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    promises: {
      readFile: async (path) => {
        if (options.pidFiles && Object.prototype.hasOwnProperty.call(options.pidFiles, path))
          return `${options.pidFiles[path]}\n`;
        // cmdline validation: return a dnsmasq cmdline for any PID listed in pidFiles
        const cmdlineMatch = path.match(/^\/proc\/(\d+)\/cmdline$/);
        if (cmdlineMatch && options.pidFiles) {
          const pid = parseInt(cmdlineMatch[1], 10);
          const knownPids = Object.values(options.pidFiles).map(v => parseInt(v, 10));
          if (knownPids.includes(pid))
            return `dnsmasq\0--conf-file=dns.br0.conf\0`;
        }
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      readdir: async (path) => {
        if (options.pidDirEntries && path === '/home/pi/.router/run/dnsmasq')
          return options.pidDirEntries;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      rmdir: async () => {},
      writeFile: async () => {},
      opendir: async function* () {},
    },
  };

  const loggerStub = () => ({
    info: (...args) => { logs.info.push(args); },
    warn: (...args) => { logs.warn.push(args); },
    error: (...args) => { logs.error.push(args); },
    debug: (...args) => { logs.debug.push(args); },
    verbose: (...args) => { logs.verbose.push(args); },
  });

  const DNSMASQ = proxyquire('../extension/dnsmasq/dnsmasq.js', {
    '../../net2/logger.js': loggerStub,
    '../../net2/Firewalla.js': {
      getUserID: () => 'pi',
      getUserConfigFolder: () => '/tmp/firewalla/config',
      getUserHome: () => '/home/pi',
      getRuntimeInfoFolder: () => '/tmp/firewalla/run',
      getFirewallaHome: () => '/home/pi/firewalla',
      isMain: () => false,
    },
    '../../util/redis_manager.js': {
      getRedisClient: () => redisClient,
      getSubscriptionClient: () => ({ on: () => {}, subscribe: () => {} }),
    },
    '../../platform/PlatformLoader.js': {
      getPlatform: () => ({
        getDNSServiceName: () => options.fireRouterManaged ? 'firerouter_dns' : 'dnsmasq',
        getDHCPServiceName: () => options.fireRouterManaged ? 'firerouter_dhcp' : 'dnsmasq',
        isFireRouterManaged: () => Boolean(options.fireRouterManaged),
      })
    },
    '../../net2/config.js': {
      getConfig: () => ({
        dns: { useDnsmasqReloadForRestart: options.useDnsmasqReloadForRestart },
        firerouter: { hiddenFolder: '/.router' }
      })
    },
    '../../sensor/SensorEventManager.js': {
      getInstance: () => ({ once: () => {}, on: () => {}, sendEventToFireMain: () => {} })
    },
    'child_process': { exec },
    'fs': fsStub,
    '../../net2/Mode.js': {},
    '../../net2/DNSTool.js': class { constructor() {} },
    '../../net2/Message.js': {},
    '../../net2/Iptables.js': { Rule: class {}, getDNSRedirectChain: () => 'FW_DNS' },
    '../../control/IptablesControl.js': {},
    '../../net2/Ipset.js': {},
    '../../lib/Bone.js': {},
    '../../net2/SysManager': {
      myDefaultDns: () => [],
      getInterfaceViaUUID: (uuid) => options.interfacesByUUID ? options.interfacesByUUID[uuid] : undefined,
      getMonitoringInterfaces: () => options.monitoringInterfaces || [],
      myResolver: () => [],
      myResolver6: () => [],
    },
    '../../net2/FlowUtil.js': {},
    '../../net2/Constants.js': {},
    '../../net2/VirtWanGroup.js': class {},
    '../vpnclient/VPNClient.js': class {},
    '../../util/util.js': {
      isHashDomain: () => false,
      formulateHostname: h => h,
      isDomainValid: () => true,
      fileRemove: async () => {},
    },
    '../../vendor_lib/async-lock': class {
      acquire(key, fn) { return fn(); }
    },
    'validator': { isIP: () => true },
    'ip-address': { Address4: class {} },
  });

  const dnsmasq = new DNSMASQ();
  dnsmasq.restoreTestTimers = () => {
    global.setTimeout = oldSetTimeout;
    global.clearTimeout = oldClearTimeout;
  };

  return { dnsmasq, commands, redisOps, timers, logs };
}

describe('dnsmasq restart/reload switch', function() {
  afterEach(function() {
    if (this.currentTest.ctx.dnsmasq)
      this.currentTest.ctx.dnsmasq.restoreTestTimers();
  });

  it('reloads firerouter dns config when the switch is enabled', async function() {
    const { dnsmasq, commands, timers, logs } = loadDNSMASQ({
      fireRouterManaged: true,
      useDnsmasqReloadForRestart: true,
      md5Before: 'old',
      md5: 'new',
      pidDirEntries: ['dnsmasq.br0.pid', 'dnsmasq.br1.pid'],
      pidFiles: {
        '/home/pi/.router/run/dnsmasq/dnsmasq.br0.pid': '1357',
        '/home/pi/.router/run/dnsmasq/dnsmasq.br1.pid': '2468',
      },
    });
    this.test.ctx.dnsmasq = dnsmasq;

    dnsmasq.scheduleRestartDNSService();
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('sudo kill -RTMIN 1357'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('sudo kill -RTMIN 2468'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dns'))).to.equal(false);
    expect(dnsmasq.counter.reloadConfig).to.equal(1);
  });

  it('falls back to firerouter dns restart when the switch is enabled but no pid is found', async function() {
    const { dnsmasq, commands, timers, logs } = loadDNSMASQ({
      fireRouterManaged: true,
      useDnsmasqReloadForRestart: true,
      md5Before: 'old',
      md5: 'new',
      pidDirEntries: [],
    });
    this.test.ctx.dnsmasq = dnsmasq;

    dnsmasq.scheduleRestartDNSService();
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('kill -RTMIN'))).to.equal(false);
    expect(commands.some(cmd => cmd.includes('systemctl stop firerouter_dns'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dns'))).to.equal(true);
    expect(logs.warn.some(args => String(args[0]).includes('no dnsmasq pid found'))).to.equal(true);
  });

  it('falls back to firerouter dns restart when config reload signal fails', async function() {
    const { dnsmasq, commands, timers, logs } = loadDNSMASQ({
      fireRouterManaged: true,
      useDnsmasqReloadForRestart: true,
      md5Before: 'old',
      md5: 'new',
      killFails: true,
      pidDirEntries: ['dnsmasq.br0.pid'],
      pidFiles: {
        '/home/pi/.router/run/dnsmasq/dnsmasq.br0.pid': '1357',
      },
    });
    this.test.ctx.dnsmasq = dnsmasq;

    dnsmasq.scheduleRestartDNSService();
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('sudo kill -RTMIN 1357'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl stop firerouter_dns'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dns'))).to.equal(true);
    expect(logs.warn.some(args => String(args[0]).includes('falling back to service restart'))).to.equal(true);
    expect(dnsmasq.counter.reloadConfig).to.equal(0);
  });

  it('restarts firerouter dns service when the switch is disabled', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      useDnsmasqReloadForRestart: false,
      md5Before: 'old',
      md5: 'new',
    });
    this.test.ctx.dnsmasq = dnsmasq;

    dnsmasq.scheduleRestartDNSService();
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('systemctl stop firerouter_dns'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dns'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('kill -RTMIN'))).to.equal(false);
  });

  it('keeps firerouter dns restart as default when the switch is unset', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      md5Before: 'old',
      md5: 'new',
    });
    this.test.ctx.dnsmasq = dnsmasq;

    dnsmasq.scheduleRestartDNSService();
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('systemctl stop firerouter_dns'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dns'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('kill -RTMIN'))).to.equal(false);
  });

  it('keeps restarting non-firerouter dns service even when the switch is enabled', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({
      fireRouterManaged: false,
      useDnsmasqReloadForRestart: true,
      md5Before: 'old',
      md5: 'new',
    });
    this.test.ctx.dnsmasq = dnsmasq;

    dnsmasq.scheduleRestartDNSService();
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('systemctl stop dnsmasq'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl restart dnsmasq'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('kill -RTMIN'))).to.equal(false);
  });

  it('dnsStatusCheck forces firerouter dns restart for recovery even when the switch is enabled', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      useDnsmasqReloadForRestart: true,
      monitoringInterfaces: [{ uuid: 'lan1', name: 'br0' }],
      interfacesByUUID: { lan1: { uuid: 'lan1', name: 'br0' } },
    });
    this.test.ctx.dnsmasq = dnsmasq;

    dnsmasq.networkFailCountMap = { lan1: 2 };  // simulate 2 prior failures so the 3rd triggers restart
    dnsmasq.verifyDNSConnectivity = async () => ({ lan1: false });
    dnsmasq.dnsUpstreamConnectivity = async () => true;
    dnsmasq._manipulate_ipv4_iptables_rule = async () => {};
    dnsmasq._manipulate_ipv6_iptables_rule = async () => {};
    dnsmasq._remove_conntrack_entries = async () => {};
    await dnsmasq.dnsStatusCheck();
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('systemctl stop firerouter_dns'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dns'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('kill -RTMIN'))).to.equal(false);
  });

  it('keeps force restart sticky when a normal restart request debounces it', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      useDnsmasqReloadForRestart: true,
      md5Before: 'old',
      md5: 'new',
      pidDirEntries: ['dnsmasq.br0.pid'],
      pidFiles: {
        '/home/pi/.router/run/dnsmasq/dnsmasq.br0.pid': '1357',
      },
    });
    this.test.ctx.dnsmasq = dnsmasq;

    dnsmasq.scheduleRestartDNSService(true, true);
    dnsmasq.scheduleRestartDNSService(false, false);
    await timers[1].fn();

    expect(timers[0].cleared).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl stop firerouter_dns'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dns'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('kill -RTMIN'))).to.equal(false);
  });
});
