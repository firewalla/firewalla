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

// Captive portal of AP SSID profiles with captivePortal set. The box redirects HTTP of the guests
// fwapc has not authorized to the portal page server, their DNS to the box, and drops the rest:
// the MACs now on a captive SSID and not authorized, in an ipset per network. Other devices on the
// network (other SSIDs, wired) are never matched.
//
// While any captive SSID exists the sensor runs the page server: SERVER_DIR/server.js when one is
// installed there (a replacement, later the asset), else the built-in test version in
// extension/captiveportal. It gets PORT, FWAPC_URL and USER_DIR (page settings), answers any GET
// with its page and logs a guest in with POST <FWAPC_URL>/v1/captive/authorized {mac}. Sensor
// config `port` (8890 when unset) applies without a restart.

const log = require('../net2/logger.js')(__filename);
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const execAsync = require('child-process-promise').exec;
const Sensor = require('./Sensor.js').Sensor;
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const { Rule } = require('../net2/Iptables.js');
const iptc = require('../control/IptablesControl.js');
const Config = require('../net2/config.js');
const fwapc = require('../net2/fwapc.js');
const Ipset = require('../net2/Ipset.js');
const ipsetControl = require('../control/IpsetControl.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

const SERVER_DIR = '/home/pi/.firewalla/run/captive-portal';
const BUILTIN_SERVER = path.join(__dirname, '../extension/captiveportal/server.js');
const USER_DIR = '/home/pi/.firewalla/config/captive-portal';
const LOG_FILE = '/home/pi/.forever/captive-portal.log';
// the live and staging sets, alike so they can be swapped
const SET_OPTIONS = { timeout: 0 };
const NAT_CHAIN = 'FW_PREROUTING_CAPTIVE';
const FWD_CHAIN = 'FW_FORWARD_CAPTIVE';
const PORT = 8890;
const CHECK_SECS = 10;
const RESTART_SECS = 10;
// a server that misses this many checks in a row is restarted
const HEALTH_FAILS = 3;
const STA_UPDATE = 'fwapc:ssid_station_update';
const RADIUS_AUTH = 'radius_auth_event';
// a guest RADIUS let in stays held this long, until fwapc lists it as a station
const PENDING_SECS = 60;

class CaptivePortalPlugin extends Sensor {
  async run() {
    // APs, and so fwapc, only on these platforms
    if (!platform.isFireRouterManaged())
      return;
    this.server = null;
    this.wanted = false;
    // interface -> port, with rules in place
    this.portals = {};
    this.healthFails = 0;
    this.port = PORT;
    // "<MAC>|<profile id>" -> ms when RADIUS accepted it
    this.pending = new Map();
    for (const fam of [4, 6]) {
      for (const table of ['nat', 'filter'])
        await iptc.addRule(new Rule(table).fam(fam).chn(table == 'nat' ? NAT_CHAIN : FWD_CHAIN).opr('-N'));
      await iptc.addRule(new Rule('nat').fam(fam).chn('FW_PREROUTING').jmp(NAT_CHAIN).opr('-I'));
      await iptc.addRule(new Rule('filter').fam(fam).chn('FW_FORWARD').jmp(FWD_CHAIN).opr('-I'));
    }
    // fwapc publishes every login and removal, and every station join and leave; a join can come
    // 10s+ after the guest connects, too late for its OS captive check, while freeradius publishes
    // the MAC auth accept before the guest connects
    sclient.subscribe('captive_auth_event');
    sclient.subscribe(STA_UPDATE);
    sclient.subscribe(RADIUS_AUTH);
    sclient.on('message', (channel, message) => {
      if (channel === 'captive_auth_event') this.sync();
      if (channel === STA_UPDATE) this.onStation(message);
      if (channel === RADIUS_AUTH) this.onRadiusAuth(message);
    });
    this.sync();
    setInterval(() => this.sync(), CHECK_SECS * 1000);
  }

  async onConfigChange() {
    this.sync();
  }

  // a bad value keeps the port in use, so guests never lose a working portal
  serverPort() {
    const value = this.config.port;
    if (value === undefined || value === null) return PORT;
    const port = typeof value === 'number' || /^\d+$/.test(value) ? Number(value) : NaN;
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    if (value !== this.badPort) log.warn(`Captive portal port ${value} is invalid, keeping ${this.port}`);
    this.badPort = value;
    return this.port;
  }

  sync() {
    // one at a time, a later call runs again after it
    if (this.syncing) {
      this.again = true;
      return;
    }
    this.syncing = true;
    this.check()
      .catch(err => log.warn('Captive portal sync failed', err.message))
      .then(() => {
        this.syncing = false;
        if (this.again) {
          this.again = false;
          this.sync();
        }
      });
  }

  // a guest joining a captive SSID is caught at once, not at the next sync
  onStation(message) {
    let msg = null;
    try {
      msg = JSON.parse(message);
    } catch (err) {
      return;
    }
    const mac = msg && msg.station && msg.station.macAddr && msg.station.macAddr.toUpperCase();
    const intfs = (this.profileIntfs || {})[msg && msg.id];
    if (!mac || !intfs) return;
    if (msg.action === 'join') this.hold(mac, msg.id, intfs);
    this.sync();
  }

  // a MAC auth accept on a captive SSID, by name or the hidden <name>-OWE of OWE transition
  onRadiusAuth(message) {
    let msg = null;
    try {
      message = message.trim();
      msg = JSON.parse(message.startsWith('{') ? message : `{${message}}`);
    } catch (err) {
      return;
    }
    if (!msg || msg.result !== 'Access-Accept') return;
    const mac = typeof msg.mac === 'string' && msg.mac.toUpperCase();
    const id = (this.captiveSsids || {})[msg.ssid];
    const intfs = (this.profileIntfs || {})[id];
    if (!hostTool.isMacAddress(mac) || !intfs) return;
    this.pending.set(`${mac}|${id}`, Date.now());
    this.hold(mac, id, intfs);
  }

  hold(mac, id, intfs) {
    if (!hostTool.isMacAddress(mac) || (this.authorized || new Set()).has(`${mac}|${id}`)) return;
    for (const intf of intfs)
      execAsync(`sudo ipset add -! ${setName(intf)} ${mac}`).catch(err => log.warn('Captive portal add failed', err.message));
  }

  async check() {
    const config = await fwapc.apiCall('GET', '/config/active');
    if (config.code !== 200 || !config.body) return;
    const profiles = config.body.profile || {};
    const captive = Object.keys(profiles).filter(id => profiles[id] && profiles[id].captivePortal);
    const port = this.port = this.serverPort();
    // box interface -> { profiles } of its captive SSIDs
    const intfs = {};
    const profileIntfs = {};
    for (const net of Object.values(config.body.assets_template || {}).flatMap(t => t.wifiNetworks || [])) {
      for (const id of (net.ssidProfiles || []).filter(x => captive.includes(x))) {
        const portal = intfs[net.intf] || (intfs[net.intf] = { profiles: [] });
        if (!portal.profiles.includes(id)) portal.profiles.push(id);
        const list = profileIntfs[id] || (profileIntfs[id] = []);
        if (!list.includes(net.intf)) list.push(net.intf);
      }
    }

    for (const intf of Object.keys(this.portals))
      if (!intfs[intf] || port !== this.portals[intf]) await this.stopPortal(intf);
    // also puts back a set or rule removed by a firewall reload; -A skips existing rules
    for (const intf of Object.keys(intfs)) await this.startPortal(intf, port);
    this.profileIntfs = profileIntfs;
    const captiveSsids = {};
    for (const id of captive.filter(x => profileIntfs[x] && typeof profiles[x].ssid === 'string')) {
      captiveSsids[profiles[id].ssid] = id;
      captiveSsids[`${profiles[id].ssid}-OWE`] = id;
    }
    this.captiveSsids = captiveSsids;
    const now = Date.now();
    for (const [key, at] of this.pending)
      if (now - at > PENDING_SECS * 1000) this.pending.delete(key);

    if (Object.keys(intfs).length) {
      const r = await fwapc.apiCall('GET', '/captive/authorized');
      const status = await fwapc.getAllSSIDStatus();
      if (r.code === 200 && Array.isArray(r.body) && status) {
        const now = Date.now() / 1000;
        this.authorized = new Set(r.body.filter(x => x.expiresAt > now).map(x => `${x.mac}|${x.ssid}`));
        for (const intf of Object.keys(intfs)) {
          // every list of the profile: "phy" and "vlan:<id>"
          const macs = new Set();
          for (const id of intfs[intf].profiles)
            for (const list of Object.values(status[id] || {}).filter(Array.isArray))
              for (const mac of list.map(x => x.toUpperCase()))
                if (!this.authorized.has(`${mac}|${id}`)) macs.add(mac);
          for (const key of this.pending.keys()) {
            const [mac, id] = key.split('|');
            if (intfs[intf].profiles.includes(id) && !this.authorized.has(key)) macs.add(mac);
          }
          await this.replaceMembers(setName(intf), macs);
        }
      }
    }

    this.wanted = captive.length > 0;
    const installed = path.join(SERVER_DIR, 'server.js');
    const script = this.wanted ? (fs.existsSync(installed) ? installed : BUILTIN_SERVER) : null;
    const key = script && `${script}:${port}`;
    if (this.server && this.server.key !== key) this.stopServer();
    if (key && !this.server) this.startServer(script, port, key);
    if (this.server) await this.checkHealth(port);
  }

  // a hung server leaves every guest on a blank page
  async checkHealth(port) {
    const server = this.server;
    if (Date.now() - server.startedAt < CHECK_SECS * 2000) return;
    // the whole page, with a success status, within the deadline
    const ok = await new Promise(resolve => {
      const timer = setTimeout(() => done(false), 3000);
      const done = result => {
        clearTimeout(timer);
        req.destroy();
        resolve(result);
      };
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, res => {
        res.resume();
        res.on('end', () => done(res.statusCode >= 200 && res.statusCode < 400));
        res.on('error', () => done(false));
      });
      req.on('error', () => done(false));
    });
    this.healthFails = ok ? 0 : this.healthFails + 1;
    if (this.healthFails >= HEALTH_FAILS && this.server === server) {
      log.warn(`Captive portal server not answering on ${port}, restarting`);
      this.healthFails = 0;
      // the exit handler starts it again
      server.kill('SIGKILL');
    }
  }

  rules(intf, port) {
    const set = setName(intf);
    const fams = [4, 6];
    return [
      new Rule('nat').chn(NAT_CHAIN).iif(intf).set(set, 'src').pro('tcp').dport(80)
        .jmp(`REDIRECT --to-ports ${port}`),
      // also a device's own resolver (e.g. 8.8.8.8)
      ...fams.flatMap(fam => ['udp', 'tcp'].map(p => new Rule('nat').fam(fam).chn(NAT_CHAIN).iif(intf)
        .set(set, 'src').pro(p).dport(53).jmp('REDIRECT --to-ports 53'))),
      // HTTPS can't be redirected without a certificate error, so fail it fast
      ...fams.flatMap(fam => [
        new Rule('filter').fam(fam).chn(FWD_CHAIN).iif(intf).set(set, 'src').pro('tcp')
          .jmp('REJECT --reject-with tcp-reset'),
        new Rule('filter').fam(fam).chn(FWD_CHAIN).iif(intf).set(set, 'src').jmp('DROP'),
      ]),
    ];
  }

  async startPortal(intf, port) {
    const set = setName(intf);
    // queued with the firewall rules while the box starts
    await Ipset.create(set, 'hash:mac', false, SET_OPTIONS);
    for (const rule of this.rules(intf, port)) await iptc.addRule(rule.opr('-A'));
    if (this.portals[intf] !== port) log.info(`Captive portal on ${intf}, page on port ${port}`);
    this.portals[intf] = port;
  }

  async stopPortal(intf) {
    for (const rule of this.rules(intf, this.portals[intf])) await iptc.addRule(rule.opr('-D'));
    delete this.portals[intf];
    log.info(`Captive portal off on ${intf}`);
  }

  // the rules never see the set empty: while the box starts, IpsetControl swaps queued sets in;
  // later a staging set is filled and swapped in (a leftover _swp set is cleaned at start)
  async replaceMembers(set, macs) {
    const valid = Array.from(macs).filter(mac => /^[0-9A-F:]{17}$/.test(mac));
    if (ipsetControl.phase !== 'autonomous') {
      await Ipset.restore([`flush ${set}`, ...valid.map(mac => `add ${set} ${mac}`)]);
      return;
    }
    const tmp = `${set}_swp`;
    await Ipset.create(tmp, 'hash:mac', false, SET_OPTIONS);
    await Ipset.restore([
      `flush ${tmp}`,
      ...valid.map(mac => `add ${tmp} ${mac}`),
      `swap ${tmp} ${set}`,
      `destroy ${tmp}`,
    ]);
  }

  startServer(script, port, key) {
    // one left by an earlier firemain run would hold the port
    spawnSync('pkill', ['-f', `^\\S*node ${script}$`]);
    const out = fs.openSync(LOG_FILE, 'a');
    const env = Object.assign({}, process.env, { PORT: String(port), FWAPC_URL: fwapcUrl(), USER_DIR });
    // the node that runs firemain
    const server = spawn(process.execPath, [script], { stdio: ['ignore', out, out], env });
    fs.closeSync(out);
    server.key = key;
    server.startedAt = Date.now();
    this.server = server;
    this.healthFails = 0;
    log.info(`Captive portal server started, pid ${server.pid}: ${script}`);
    const gone = reason => {
      if (this.server !== server) return;
      this.server = null;
      log.warn(`Captive portal server ${reason}`);
      setTimeout(() => this.sync(), RESTART_SECS * 1000);
    };
    server.on('error', err => gone(`failed: ${err.message}`));
    server.on('exit', code => gone(`exited with ${code}`));
  }

  stopServer() {
    const server = this.server;
    this.server = null;
    server.kill();
    log.info('Captive portal server stopped');
  }
}

// the fwapc the sensor's own calls use (net2/fwapc.js)
function fwapcUrl() {
  const intf = (Config.getConfig().fwapc || {}).interface || {};
  return `http://${intf.host || '127.0.0.1'}:${intf.port || 8841}`;
}

// ipset names are at most 31 chars, with room for _swp
function setName(intf) {
  return `c_cp_${intf.replace(/[^A-Za-z0-9]/g, '_')}`.slice(0, 27);
}

module.exports = CaptivePortalPlugin;
