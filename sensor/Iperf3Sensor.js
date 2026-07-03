/*    Copyright 2016-2021 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const extensionManager = require('./ExtensionManager.js');
const sysManager = require('../net2/SysManager.js');
const exec = require('child-process-promise').exec;
const fsp = require('fs').promises;
const f = require('../net2/Firewalla.js');
const { wrapIptables } = require('../net2/Iptables.js');

const PID_FILE = `${f.getRuntimeInfoFolder()}/iperf3.pid`;
const STORED_PORT_FILE = `${f.getRuntimeInfoFolder()}/iperf3.port`;
const WATCHDOG_INTERVAL_MS = 20 * 1000; // Periodically check whether the iperf3 server still has an active client.

class Iperf3Sensor extends Sensor {
  async apiRun() {
    this.watchdogTimer = null;
    extensionManager.onCmd("iperf3:start", () => this.start());
    extensionManager.onCmd("iperf3:stop", () => this.stop());
  }

  async start() {
    // Clean up any lingering state from a previous run that didn't stop cleanly.
    await this.disableServerAccess();

    let pid = await this.getPID();
    if (!pid)
      pid = await this.startIperf3Server();
    if (!pid)
      throw {msg: `Failed to start iperf3 server`, code: 500};
    const port = await this.getPort(pid);
    if (!port || isNaN(port))
      throw {msg: `Failed to start iperf3 server`, code: 500};
    const portNum = Number(port);

    if (await sysManager.isBridgeMode()) {
      try {
        await this.enableServerAccess(portNum);
      } catch (err) {
        log.error(`Failed to enable iperf3 server access for port ${portNum}`, err.message);
        await this.stop();
        throw {msg: `Failed to enable iperf3 server access`, code: 500};
      }
    }

    this.startWatchdog();
    return {port: portNum};
  }

  async stop() {
    this.stopWatchdog();
    await this.disableServerAccess();
    await this.stopIperf3Server();
  }

  // for bridge mode + dmz host
  async enableServerAccess(port) {
    await this.writeStoredPort(port);
    await this.addIptablesRules(port);
  }

  // for bridge mode + dmz host
  async disableServerAccess() {
    const storedPort = await this.readStoredPort();
    if (storedPort) {
      await this.removeIptablesRules(storedPort);
      await this.clearStoredPort();
    }
  }

  startWatchdog() {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(async () => {
      try {
        const pid = await this.getPID();
        if (!pid) {
          log.info(`iperf3 process is gone, cleaning up residue`);
          await this.stop();
          return;
        }
        if (!await this.hasEstablishedConnection(pid)) {
          log.info(`iperf3 has no active client connection, auto stopping`);
          await this.stop();
        }
      } catch (err) {
        // lsof or other transient failures: skip this tick instead of stopping,
        // to avoid killing a server that actually has clients.
        log.warn(`iperf3 watchdog check failed, will retry next tick: ${err.message}`);
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  // Throws on lsof failure so the watchdog can distinguish "no connection"
  // from "couldn't check" and avoid false-positive auto stop.
  async hasEstablishedConnection(pid) {
    const result = await exec(`sudo lsof -n -p ${pid}`);
    return result.stdout.includes('ESTABLISHED');
  }

  // In bridge mode + DMZ, add iptables rule to prevent flows go to dmz.
  async addIptablesRules(port) {
    await exec(wrapIptables(`sudo iptables -w -t nat -I FW_PREROUTING_DMZ_HOST -p tcp --dport ${port} -m set --match-set monitored_net_set src,src -m comment --comment "iperf3 wifi test" -j RETURN`));
    await exec(wrapIptables(`sudo iptables -w -A FW_INPUT_ACCEPT -p tcp --dport ${port} -m set --match-set monitored_net_set src,src -m comment --comment "iperf3 wifi test" -j ACCEPT`));
  }

  async removeIptablesRules(port) {
    await exec(wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_DMZ_HOST -p tcp --dport ${port} -m set --match-set monitored_net_set src,src -m comment --comment "iperf3 wifi test" -j RETURN`)).catch((err) => {
      log.error(`Failed to remove PREROUTING rule for iperf3 port ${port}`, err.message);
    });
    await exec(wrapIptables(`sudo iptables -w -D FW_INPUT_ACCEPT -p tcp --dport ${port} -m set --match-set monitored_net_set src,src -m comment --comment "iperf3 wifi test" -j ACCEPT`)).catch((err) => {
      log.error(`Failed to remove INPUT rule for iperf3 port ${port}`, err.message);
    });
  }

  async readStoredPort() {
    const content = await fsp.readFile(STORED_PORT_FILE, 'utf8').catch(() => null);
    if (!content) return null;
    const port = parseInt(content.trim());
    return isNaN(port) ? null : port;
  }

  async writeStoredPort(port) {
    await fsp.writeFile(STORED_PORT_FILE, String(port));
  }

  async clearStoredPort() {
    await fsp.unlink(STORED_PORT_FILE).catch(() => {});
  }

  async getPID() {
    // there is a trailing null character in iperf3's pid file
    const pid = await fsp.readFile(PID_FILE, {"encoding": "utf8"})
        .then((content) => content.trim().replace('\0', ''))
        .catch((err) => null);
    if (pid) {
      const comm = await fsp.readFile(`/proc/${pid}/comm`, {"encoding": "utf8"})
          .then((content) => content.trim())
          .catch((err) => null);
      return comm === "iperf3" ? pid : null;
    } else
        return null;
  }

  async startIperf3Server() {
    for (let i = 0; i != 3; i++) {
      const port = Math.ceil(Math.random() * 10000) + 10000;
      await exec(`iperf3 -s -p ${port} -I ${PID_FILE} -D`).catch((err) => {});
      const pid = await this.getPID();
      if (pid)
        return pid;
    }
    return null;
  }

  async stopIperf3Server() {
    let pid = await this.getPID();
    if (pid) {
      await exec(`kill ${pid}`).catch((err) => { });
      pid = await this.getPID();
      if (pid) {
        log.info(`iperf3 process ${pid} is not killed by SIGTERM, using SIGKILL instead`);
        await exec(`kill -9 ${pid}`).catch((err) => { });
      }
    }
  }

  async getPort(pid) {
    const listenAddr = await exec(`sudo lsof -n -p ${pid} | grep LISTEN | awk '{print $9}'`)
        .then((result) => result.stdout.trim())
        .catch((err) => null);
    if (listenAddr)
      return listenAddr.split(':')[1];
    return null;
  }
}

module.exports = Iperf3Sensor;