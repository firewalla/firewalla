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

function loadDNSMASQ(options = {}) {
  const commands = [];
  const redisOps = [];
  const timers = [];
  const fileWrites = [];
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

  // the module runs commands only through execFile from child-process-promise; its argv lands here
  // joined into one string, which is what this table and the command assertions match on
  const execResult = (cmd) => {
    commands.push(cmd);
    if (cmd.includes('find ')) {
      return { stdout: `${options.md5 || 'abc123'}\n`, stderr: '' };
    } else if (cmd.includes('kill -RTMIN')) {
      if (options.killFails)
        throw new Error('kill failed');
      return { stdout: '', stderr: '' };
    } else if (cmd.includes('systemctl reload') && options.dhcpReloadFails) {
      throw new Error('reload failed');
    } else if (cmd.includes('systemctl stop') || cmd.includes('systemctl restart') || cmd.includes('systemctl reload')) {
      return { stdout: '', stderr: '' };
    }

    return { stdout: '', stderr: '' };
  };

  // child-process-promise takes argv, resolves a result object and rejects on failure
  const execFile = async (file, args = []) => execResult([file, ...args].join(' '));

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
        if (options.files && Object.prototype.hasOwnProperty.call(options.files, path)) {
          const content = options.files[path];
          // readGate holds a read that already has the content, to model a removal landing before it returns
          if (options.readGate)
            await options.readGate;
          return content;
        }
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
        const dir = path.endsWith('/') ? path : path + '/';
        const names = Object.keys(options.files || {}).filter(p => p.startsWith(dir)).map(p => p.slice(dir.length));
        if (names.length)
          return names;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      rmdir: async () => {},
      writeFile: async (path, content) => {
        if (options.failWrites > 0) {
          options.failWrites--;
          throw Object.assign(new Error('write failed'), { code: 'EIO' });
        }
        fileWrites.push([path, content]);
      },
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
      isMain: () => Boolean(options.isMain),
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
        getDnsmasqLeaseFilePath: () => '/home/pi/.router/run/dhcp/dnsmasq.leases',
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
    'child-process-promise': { execFile },
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
      inMySubnets4: () => true,
      isMyMac: () => false,
    },
    '../../net2/HostManager.js': class {
      async getHostsAsync() { return options.hosts || []; }
    },
    '../../net2/FlowUtil.js': {},
    '../../net2/Constants.js': {},
    '../../net2/VirtWanGroup.js': class {},
    '../vpnclient/VPNClient.js': class {},
    '../../util/util.js': {
      isHashDomain: () => false,
      formulateHostname: h => h,
      isDomainValid: () => true,
      fileRemove: async (path) => {
        if (options.failRemoves > 0) {
          options.failRemoves--;
          throw Object.assign(new Error('remove failed'), { code: 'EIO' });
        }
        if (options.files) delete options.files[path];
      },
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

  return { dnsmasq, commands, redisOps, timers, fileWrites, logs };
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

describe('dnsmasq DHCP hosts-file reload vs restart', function() {
  afterEach(function() {
    if (this.currentTest.ctx.dnsmasq)
      this.currentTest.ctx.dnsmasq.restoreTestTimers();
  });

  it('reloads (not restarts) firerouter_dhcp via scheduleReloadDHCPService', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({ fireRouterManaged: true });
    this.test.ctx.dnsmasq = dnsmasq;

    dnsmasq.scheduleReloadDHCPService();
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('systemctl reload firerouter_dhcp'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dhcp'))).to.equal(false);
    expect(commands.some(cmd => cmd.includes('systemctl stop firerouter_dhcp'))).to.equal(false);
    expect(dnsmasq.counter.reloadDHCP).to.equal(1);
  });

  it('logs an error and does not fall back to restart when the DHCP reload command fails', async function() {
    const { dnsmasq, commands, timers, logs } = loadDNSMASQ({ fireRouterManaged: true, dhcpReloadFails: true });
    this.test.ctx.dnsmasq = dnsmasq;

    dnsmasq.scheduleReloadDHCPService();
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('systemctl reload firerouter_dhcp'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dhcp'))).to.equal(false);
    expect(logs.error.some(args => String(args[0]).includes('Failed to reload'))).to.equal(true);
  });

  it('skips the scheduled reload when a full DHCP restart is already pending', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({ fireRouterManaged: true });
    this.test.ctx.dnsmasq = dnsmasq;

    dnsmasq.scheduleRestartDHCPService();
    dnsmasq.scheduleReloadDHCPService();

    expect(timers.length).to.equal(1); // reload call saw restartDHCPTask pending and bailed out without scheduling
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dhcp'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl reload firerouter_dhcp'))).to.equal(false);
  });

  it('cancels a pending reload when a full DHCP restart gets scheduled afterwards', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({ fireRouterManaged: true });
    this.test.ctx.dnsmasq = dnsmasq;

    dnsmasq.scheduleReloadDHCPService();   // timers[0], reloadDHCPTask
    dnsmasq.scheduleRestartDHCPService();  // should clear timers[0] and schedule timers[1]

    expect(timers[0].cleared).to.equal(true);
    await timers[1].fn();

    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dhcp'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl reload firerouter_dhcp'))).to.equal(false);
  });

  it('clears restartDHCPTask once a full DHCP restart completes, so a later reload is not blocked forever', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({ fireRouterManaged: true });
    this.test.ctx.dnsmasq = dnsmasq;

    // simulate the unconditional restart rawStart() fires on every FireMain startup
    dnsmasq.scheduleRestartDHCPService(true);
    await timers[0].fn();

    expect(dnsmasq.restartDHCPTask).to.equal(undefined);

    // a hosts-file change coming in afterwards must still be able to schedule a reload
    dnsmasq.scheduleReloadDHCPService();
    expect(timers.length).to.equal(2);
    await timers[1].fn();

    expect(commands.some(cmd => cmd.includes('systemctl reload firerouter_dhcp'))).to.equal(true);
    expect(dnsmasq.counter.reloadDHCP).to.equal(1);
  });

  // a new reservation, so the write changes the file and schedules a DHCP action
  const reservation = { ipAllocation: { allocations: { lan1: { type: 'static', ipv4: '192.0.2.10' } } } };
  const lan = { uuid: 'lan1', name: 'br0' };

  it('writeHostsFile restarts (not reloads) DHCP on a FireRouter-managed box when it cleans up a lease', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({ fireRouterManaged: true, monitoringInterfaces: [lan] });
    this.test.ctx.dnsmasq = dnsmasq;
    dnsmasq.leaseCleanupPending = false;

    await dnsmasq.writeHostsFile({ o: { mac: 'AA:BB:CC:DD:EE:FF' }, policy: reservation });
    expect(dnsmasq.leaseCleanupPending).to.equal(true);
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dhcp'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl reload firerouter_dhcp'))).to.equal(false);
  });

  it('writeHostsFile restarts DHCP when an earlier lease cleanup is still pending', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({ fireRouterManaged: true });
    this.test.ctx.dnsmasq = dnsmasq;
    dnsmasq.leaseCleanupPending = true;

    await dnsmasq.writeHostsFile({ o: { mac: 'AA:BB:CC:DD:EE:FF' }, policy: { ipAllocation: { dhcpIgnore: true } } });
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dhcp'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl reload firerouter_dhcp'))).to.equal(false);
  });

  it('writeHostsFile schedules a DHCP reload (not restart) on a FireRouter-managed box when no lease is cleaned up', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({ fireRouterManaged: true });
    this.test.ctx.dnsmasq = dnsmasq;
    dnsmasq.leaseCleanupPending = false;

    await dnsmasq.writeHostsFile({ o: { mac: 'AA:BB:CC:DD:EE:FF' }, policy: { ipAllocation: { dhcpIgnore: true } } });
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('systemctl reload firerouter_dhcp'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dhcp'))).to.equal(false);
  });

  it('writeHostsFile falls back to a full restart on a non-FireRouter box', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({ fireRouterManaged: false, monitoringInterfaces: [lan] });
    this.test.ctx.dnsmasq = dnsmasq;

    await dnsmasq.writeHostsFile({ o: { mac: 'AA:BB:CC:DD:EE:FF' }, policy: reservation });
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('systemctl restart dnsmasq'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl reload dnsmasq'))).to.equal(false);
  });

  it('removeHostsFile schedules a DHCP reload (not restart) on a FireRouter-managed box', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({ fireRouterManaged: true });
    this.test.ctx.dnsmasq = dnsmasq;

    await dnsmasq.removeHostsFile({ o: { mac: 'AA:BB:CC:DD:EE:FF' }, getGUID: () => 'guid-1' });
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('systemctl reload firerouter_dhcp'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dhcp'))).to.equal(false);
  });

  it('removeHostsFile falls back to a full restart on a non-FireRouter box', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({ fireRouterManaged: false });
    this.test.ctx.dnsmasq = dnsmasq;

    await dnsmasq.removeHostsFile({ o: { mac: 'AA:BB:CC:DD:EE:FF' }, getGUID: () => 'guid-1' });
    await timers[0].fn();

    expect(commands.some(cmd => cmd.includes('systemctl restart dnsmasq'))).to.equal(true);
    expect(commands.some(cmd => cmd.includes('systemctl reload dnsmasq'))).to.equal(false);
  });
});

describe('dnsmasq bulk hosts-file refresh', function() {
  const HOSTS_DIR = '/home/pi/.router/config/dhcp/hosts2/';
  const RESERVED_MAC = '00:00:5E:00:53:01';
  const RESERVED_CONTENT = `${RESERVED_MAC},tag:br0,192.0.2.10\n`;
  const lan = { uuid: 'lan1', name: 'br0' };
  const LEASE_FILE = '/home/pi/.router/run/dhcp/dnsmasq.leases';

  function reservedHost() {
    return {
      o: { mac: RESERVED_MAC },
      policy: { ipAllocation: { allocations: { lan1: { type: 'static', ipv4: '192.0.2.10' } } } },
    };
  }
  function plainHost(n) {
    return { o: { mac: `00:00:5E:00:53:1${n}` }, policy: {} };
  }

  async function runPendingTimers(timers) {
    for (let i = 0; i < timers.length; i++)
      if (!timers[i].cleared) {
        timers[i].cleared = true; // a fired timer does not fire again
        await timers[i].fn();
      }
  }

  // checkConfsChange that reports each listed key as changed once and then as current, like the redis hashes
  function hashState(changedKeys) {
    const pending = new Set(changedKeys);
    const calls = [];
    const checkConfsChange = async (key, paths) => {
      calls.push({ key, paths });
      const changed = pending.has(key);
      pending.delete(key);
      return changed;
    };
    return { calls, checkConfsChange };
  }

  afterEach(function() {
    if (this.currentTest.ctx.dnsmasq)
      this.currentTest.ctx.dnsmasq.restoreTestTimers();
  });

  it('rawStart schedules one DHCP action and no per-device reload', async function() {
    const { dnsmasq, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      hosts: [reservedHost(), plainHost(1), plainHost(2)],
    });
    this.test.ctx.dnsmasq = dnsmasq;

    await dnsmasq.rawStart();

    // one DNS timer and one DHCP timer, whatever the number of devices
    expect(timers.length).to.equal(2);
    expect(dnsmasq.reloadDHCPTask).to.equal(undefined);
    expect(dnsmasq.restartDHCPTask).to.not.equal(undefined);
  });

  it('rawStart does not restart DHCP when the DHCP config is unchanged', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      hosts: [reservedHost(), plainHost(1)],
      files: { [HOSTS_DIR + RESERVED_MAC]: RESERVED_CONTENT },
    });
    this.test.ctx.dnsmasq = dnsmasq;
    dnsmasq.checkConfsChange = async () => false;
    dnsmasq.leaseCleanupPending = false; // a DHCP restart already ran since FireMain started

    await dnsmasq.rawStart();
    await runPendingTimers(timers);

    expect(commands.some(cmd => cmd.includes('firerouter_dhcp'))).to.equal(false);
  });

  it('the first rawStart after FireMain starts restarts DHCP once even when the hashes match', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      hosts: [reservedHost(), plainHost(1)],
      files: { [HOSTS_DIR + RESERVED_MAC]: RESERVED_CONTENT },
    });
    this.test.ctx.dnsmasq = dnsmasq;
    dnsmasq.checkConfsChange = async () => false;

    await dnsmasq.rawStart();
    await runPendingTimers(timers);
    await dnsmasq.rawStart();
    await runPendingTimers(timers);

    expect(commands.filter(cmd => cmd.includes('systemctl restart firerouter_dhcp')).length).to.equal(1);
  });

  it('a lease cleanup by a single-device write before the full rewrite still gets a DHCP restart', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      hosts: [reservedHost(), plainHost(1)],
      files: { [HOSTS_DIR + RESERVED_MAC]: `${RESERVED_MAC},tag:br0,192.0.2.20\n` },
    });
    this.test.ctx.dnsmasq = dnsmasq;
    dnsmasq.checkConfsChange = async () => false;
    dnsmasq.leaseCleanupPending = false;

    // the reservation moved from .20 to .10, so the single-device path rewrites it and cleans up the lease
    await dnsmasq.writeHostsFile(reservedHost());
    await dnsmasq.rawStart();
    await runPendingTimers(timers);

    expect(commands.filter(cmd => cmd.includes('sed')).length).to.equal(1);
    expect(commands.filter(cmd => cmd.includes('systemctl restart firerouter_dhcp')).length).to.equal(1);
  });

  it('rawStart restarts DHCP once when the DHCP config changed', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      hosts: [reservedHost(), plainHost(1), plainHost(2)],
    });
    this.test.ctx.dnsmasq = dnsmasq;
    dnsmasq.checkConfsChange = async () => true;

    await dnsmasq.rawStart();
    await runPendingTimers(timers);

    expect(commands.filter(cmd => cmd.includes('systemctl restart firerouter_dhcp')).length).to.equal(1);
    expect(commands.some(cmd => cmd.includes('systemctl reload firerouter_dhcp'))).to.equal(false);
  });

  it('a bulk write leaves an unchanged reservation file and its lease record alone', async function() {
    const { dnsmasq, commands, fileWrites } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      files: {
        [HOSTS_DIR + RESERVED_MAC]: RESERVED_CONTENT,
        [LEASE_FILE]: `1792000000 ${RESERVED_MAC.toLowerCase()} 192.0.2.10 test-device *\n`,
      },
    });
    this.test.ctx.dnsmasq = dnsmasq;

    await dnsmasq.writeHostsFile(reservedHost(), true);

    expect(fileWrites.length).to.equal(0);
    expect(commands.some(cmd => cmd.includes('sed'))).to.equal(false);
  });

  it('after a FireMain restart, a single-device write of an unchanged reservation does nothing', async function() {
    const { dnsmasq, commands, fileWrites, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      files: { [HOSTS_DIR + RESERVED_MAC]: RESERVED_CONTENT },
    });
    this.test.ctx.dnsmasq = dnsmasq;

    // a fresh instance has no in-memory hash; it is seeded from the file on disk
    await dnsmasq.writeHostsFile(reservedHost());

    expect(fileWrites.length).to.equal(0);
    expect(commands.some(cmd => cmd.includes('sed'))).to.equal(false);
    expect(timers.length).to.equal(0);
  });

  it('FireMain seeds the hosts-file hashes when it starts, before any write', async function() {
    const { dnsmasq } = loadDNSMASQ({
      fireRouterManaged: true,
      isMain: true,
      files: { [HOSTS_DIR + RESERVED_MAC]: RESERVED_CONTENT },
    });
    this.test.ctx.dnsmasq = dnsmasq;

    await dnsmasq.hostsFileHashesLoaded;

    expect(dnsmasq.lastHostsFileHash[RESERVED_MAC]).to.equal(dnsmasq.computeHash(RESERVED_CONTENT));
  });

  it('a removal during the startup read of the hashes leaves no hash for the removed file', async function() {
    let openGate;
    const readGate = new Promise(resolve => { openGate = resolve; });
    const { dnsmasq } = loadDNSMASQ({
      fireRouterManaged: true,
      isMain: true,
      readGate,
      files: { [HOSTS_DIR + RESERVED_MAC]: RESERVED_CONTENT },
    });
    this.test.ctx.dnsmasq = dnsmasq;

    // the startup read has listed the file and holds its content, but has not stored the hash yet
    await new Promise(resolve => setImmediate(resolve));
    const removal = dnsmasq.removeHostsFile({ o: { mac: RESERVED_MAC }, getGUID: () => RESERVED_MAC });
    openGate();
    await removal;
    await dnsmasq.hostsFileHashesLoaded;

    expect(dnsmasq.lastHostsFileHash).to.not.have.property(RESERVED_MAC);
  });

  it('a stale-file removal during the startup read of the hashes leaves no hash for the removed file', async function() {
    let openGate;
    const readGate = new Promise(resolve => { openGate = resolve; });
    const { dnsmasq } = loadDNSMASQ({
      fireRouterManaged: true,
      isMain: true,
      readGate,
      hosts: [],
      files: { [HOSTS_DIR + RESERVED_MAC]: RESERVED_CONTENT },
    });
    this.test.ctx.dnsmasq = dnsmasq;

    await new Promise(resolve => setImmediate(resolve));
    const rewrite = dnsmasq.writeAllHostsFiles();
    // release the read only after a rewrite that does not wait for it would already have removed the file
    setImmediate(openGate);
    await rewrite;
    await dnsmasq.hostsFileHashesLoaded;

    expect(dnsmasq.lastHostsFileHash).to.not.have.property(RESERVED_MAC);
  });

  it('a reservation file whose write failed is written again on the next call', async function() {
    const { dnsmasq, fileWrites } = loadDNSMASQ({ fireRouterManaged: true, monitoringInterfaces: [lan], failWrites: 1 });
    this.test.ctx.dnsmasq = dnsmasq;

    await dnsmasq.writeHostsFile(reservedHost()).catch(() => {});
    await dnsmasq.writeHostsFile(reservedHost());

    expect(fileWrites).to.deep.equal([[HOSTS_DIR + RESERVED_MAC, RESERVED_CONTENT]]);
  });

  it('a hosts file whose removal failed is removed again on the next call', async function() {
    const files = { [HOSTS_DIR + RESERVED_MAC]: RESERVED_CONTENT };
    const { dnsmasq } = loadDNSMASQ({ fireRouterManaged: true, monitoringInterfaces: [lan], files, failRemoves: 1 });
    this.test.ctx.dnsmasq = dnsmasq;
    // the reservation was removed, so the device now has no lines
    const unreserved = { o: { mac: RESERVED_MAC }, policy: {} };

    await dnsmasq.writeHostsFile(unreserved);
    expect(files).to.have.property(HOSTS_DIR + RESERVED_MAC);
    await dnsmasq.writeHostsFile(unreserved);

    expect(files).to.not.have.property(HOSTS_DIR + RESERVED_MAC);
  });

  it('a hosts file the full rewrite removed as stale is written again when its device comes back', async function() {
    const { dnsmasq, fileWrites } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      hosts: [],
      files: { [HOSTS_DIR + RESERVED_MAC]: RESERVED_CONTENT },
    });
    this.test.ctx.dnsmasq = dnsmasq;
    await dnsmasq.loadHostsFileHashes(); // a running FireMain has already seen the file

    await dnsmasq.writeAllHostsFiles();
    await dnsmasq.writeHostsFile(reservedHost());

    expect(fileWrites).to.deep.equal([[HOSTS_DIR + RESERVED_MAC, RESERVED_CONTENT]]);
  });

  it('a bulk write of an unchanged reservation still clears a lease another MAC holds on its IP', async function() {
    const { dnsmasq, commands } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      files: {
        [HOSTS_DIR + RESERVED_MAC]: RESERVED_CONTENT,
        [LEASE_FILE]: '1792000000 00:00:5e:00:53:99 192.0.2.10 other-device *\n',
      },
    });
    this.test.ctx.dnsmasq = dnsmasq;
    dnsmasq.leaseCleanupPending = false;

    await dnsmasq.writeHostsFile(reservedHost(), true);

    expect(commands.some(cmd => cmd.includes('sed') && cmd.includes('192.0.2.10'))).to.equal(true);
    expect(dnsmasq.leaseCleanupPending).to.equal(true);
  });

  it('a lease deleted directly through deleteLeaseRecord gets the next DHCP restart even when the hashes match', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({ fireRouterManaged: true });
    this.test.ctx.dnsmasq = dnsmasq;
    dnsmasq.checkConfsChange = async () => false;
    dnsmasq.leaseCleanupPending = false;

    // the shape of the netbot path that forgets a device
    await dnsmasq.deleteLeaseRecord('00:00:5E:00:53:99');
    dnsmasq.scheduleRestartDHCPService();
    await timers[0].fn();

    expect(commands.filter(cmd => cmd.includes('systemctl restart firerouter_dhcp')).length).to.equal(1);
    expect(dnsmasq.leaseCleanupPending).to.equal(false);
  });

  it('a bulk write rewrites a changed reservation file and clears the lease on its IP', async function() {
    const { dnsmasq, commands, fileWrites } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      files: { [HOSTS_DIR + RESERVED_MAC]: `${RESERVED_MAC},tag:br0,192.0.2.20\n` },
    });
    this.test.ctx.dnsmasq = dnsmasq;

    await dnsmasq.writeHostsFile(reservedHost(), true);

    expect(fileWrites).to.deep.equal([[HOSTS_DIR + RESERVED_MAC, RESERVED_CONTENT]]);
    expect(commands.some(cmd => cmd.includes('sed') && cmd.includes('192.0.2.10'))).to.equal(true);
  });

  it('rawStart reloads, not restarts, DHCP when only the reservations differ from what dnsmasq last loaded', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      hosts: [plainHost(1)],
    });
    this.test.ctx.dnsmasq = dnsmasq;
    dnsmasq.checkConfsChange = hashState(['dnsmasq:dhcphosts']).checkConfsChange;
    dnsmasq.leaseCleanupPending = false;

    await dnsmasq.rawStart();
    await runPendingTimers(timers);

    expect(commands.filter(cmd => cmd.includes('systemctl reload firerouter_dhcp')).length).to.equal(1);
    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dhcp'))).to.equal(false);
  });

  it('a conf change restarts DHCP and records the reservations as applied, so no reload follows', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      hosts: [plainHost(1)],
    });
    this.test.ctx.dnsmasq = dnsmasq;
    dnsmasq.checkConfsChange = hashState(['dnsmasq:dhcp', 'dnsmasq:dhcphosts']).checkConfsChange;
    dnsmasq.leaseCleanupPending = false;

    await dnsmasq.rawStart();
    await runPendingTimers(timers);
    dnsmasq.scheduleReloadDHCPService();
    await runPendingTimers(timers);

    expect(commands.filter(cmd => cmd.includes('systemctl restart firerouter_dhcp')).length).to.equal(1);
    expect(commands.some(cmd => cmd.includes('systemctl reload firerouter_dhcp'))).to.equal(false);
  });

  it('dnsmasq:dhcp hashes only what needs a restart, and dnsmasq:dhcphosts only the reservations', async function() {
    const { dnsmasq, timers } = loadDNSMASQ({ fireRouterManaged: true });
    this.test.ctx.dnsmasq = dnsmasq;
    const state = hashState(['dnsmasq:dhcp']);
    dnsmasq.checkConfsChange = state.checkConfsChange;

    dnsmasq.scheduleRestartDHCPService();
    await runPendingTimers(timers);

    const restartKey = state.calls.find(c => c.key === 'dnsmasq:dhcp');
    const hostsKey = state.calls.find(c => c.key === 'dnsmasq:dhcphosts');
    expect(restartKey.paths).to.not.include(HOSTS_DIR);
    expect(restartKey.paths).to.include('/home/pi/.router/config/dhcp/conf');
    expect(hostsKey.paths).to.deep.equal([HOSTS_DIR]);
  });

  it('rawStart restarts DHCP after a lease cleanup in the full rewrite even when the hashes match', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      hosts: [reservedHost(), plainHost(1)],
      files: { [HOSTS_DIR + RESERVED_MAC]: `${RESERVED_MAC},tag:br0,192.0.2.20\n` },
    });
    this.test.ctx.dnsmasq = dnsmasq;
    // a restart already pending when the full rewrite starts can record both hashes before the cleanup ends
    dnsmasq.checkConfsChange = async () => false;
    dnsmasq.leaseCleanupPending = false;

    await dnsmasq.rawStart();
    await runPendingTimers(timers);

    expect(commands.some(cmd => cmd.includes('sed') && cmd.includes('192.0.2.10'))).to.equal(true);
    expect(commands.filter(cmd => cmd.includes('systemctl restart firerouter_dhcp')).length).to.equal(1);
  });

  it('a DHCP restart pending when the full rewrite starts does not fire during it, leaving one restart', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      hosts: [plainHost(1), reservedHost()],
      files: { [HOSTS_DIR + RESERVED_MAC]: `${RESERVED_MAC},tag:br0,192.0.2.20\n` },
    });
    this.test.ctx.dnsmasq = dnsmasq;
    dnsmasq.checkConfsChange = async () => false;
    // FireMain start: the startup lease flag is set, and DnsmasqDhcpSensor queues a restart
    dnsmasq.scheduleRestartDHCPService();
    // each host write in the bulk loop is a moment where an expired timer could fire
    const writeHostsFile = dnsmasq.writeHostsFile.bind(dnsmasq);
    dnsmasq.writeHostsFile = async (...args) => {
      await runPendingTimers(timers);
      return writeHostsFile(...args);
    };

    await dnsmasq.rawStart();
    await runPendingTimers(timers);

    expect(commands.some(cmd => cmd.includes('sed') && cmd.includes('192.0.2.10'))).to.equal(true);
    expect(commands.filter(cmd => cmd.includes('systemctl restart firerouter_dhcp')).length).to.equal(1);
  });

  it('a DHCP reload pending when the full rewrite starts is folded into the action after the loop', async function() {
    const { dnsmasq, commands, timers } = loadDNSMASQ({
      fireRouterManaged: true,
      monitoringInterfaces: [lan],
      hosts: [plainHost(1)],
    });
    this.test.ctx.dnsmasq = dnsmasq;
    dnsmasq.checkConfsChange = hashState(['dnsmasq:dhcphosts']).checkConfsChange;
    dnsmasq.leaseCleanupPending = false;

    dnsmasq.scheduleReloadDHCPService();
    await dnsmasq.rawStart();

    expect(timers[0].cleared).to.equal(true);
    await runPendingTimers(timers);

    expect(commands.filter(cmd => cmd.includes('systemctl reload firerouter_dhcp')).length).to.equal(1);
    expect(commands.some(cmd => cmd.includes('systemctl restart firerouter_dhcp'))).to.equal(false);
  });
});
