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
const BYPASS_PORT_FILE = `${f.getRuntimeInfoFolder()}/iperf3.bypass_port`;

class Iperf3Sensor extends Sensor {
  async apiRun() {
    extensionManager.onCmd("iperf3:start", async (msg, data) => {
      const bridgeMode = await sysManager.isBridgeMode();

      // Clean up any lingering bypass rules from a previous run that didn't stop cleanly.
      const oldPort = await this.readStoredBypassPort();
      if (oldPort) {
        await this.removeBypassRules(oldPort);
        await this.clearStoredBypassPort();
      }

      let pid = await this.getPID();
      if (!pid)
        pid = await this.startIperf3Server();
      if (!pid)
        throw {msg: `Failed to start iperf3 server`, code: 500};
      const port = await this.getPort(pid);
      if (!port || isNaN(port))
        throw {msg: `Failed to start iperf3 server`, code: 500};
      const portNum = Number(port);

      if (bridgeMode) {
        try {
          await this.addBypassRules(portNum);
          await this.writeStoredBypassPort(portNum);
        } catch (err) {
          log.error(`Failed to setup iperf3 bypass rules for port ${portNum}`, err.message);
          await this.removeBypassRules(portNum);
          await this.clearStoredBypassPort();
          await this.stopIperf3Server();
          throw {msg: `Failed to setup iperf3 bypass rules`, code: 500};
        }
      }

      return {port: portNum};
    });

    extensionManager.onCmd("iperf3:stop", async (msg, data) => {
      // Cleanup is driven by the port file, not the live PID, so stale rules
      // get removed even if the iperf3 process crashed before stop was called.
      const storedPort = await this.readStoredBypassPort();
      if (storedPort) {
        await this.removeBypassRules(storedPort);
        await this.clearStoredBypassPort();
      }
      await this.stopIperf3Server();
      return;
    })
  }

  // In bridge mode, Firewalla's WAN IP equals its LAN IP. With DMZ configured,
  // FW_PREROUTING_DMZ_HOST's DNAT hijacks inbound iperf3 traffic to the DMZ host,
  // so the local iperf3 process never sees the connection. Insert a RETURN at the
  // chain head to bypass DNAT for this port, plus an ACCEPT in FW_INPUT_ACCEPT so
  // the packet is allowed through the filter INPUT chain. Both are constrained to
  // monitored_net_set so WAN-side traffic is unaffected.
  async addBypassRules(port) {
    await exec(wrapIptables(`sudo iptables -w -t nat -I FW_PREROUTING_DMZ_HOST -p tcp --dport ${port} -m set --match-set monitored_net_set src,src -m comment --comment "iperf3 wifi test" -j RETURN`));
    await exec(wrapIptables(`sudo iptables -w -A FW_INPUT_ACCEPT -p tcp --dport ${port} -m set --match-set monitored_net_set src,src -m comment --comment "iperf3 wifi test" -j ACCEPT`));
  }

  async removeBypassRules(port) {
    await exec(wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_DMZ_HOST -p tcp --dport ${port} -m set --match-set monitored_net_set src,src -m comment --comment "iperf3 wifi test" -j RETURN`)).catch((err) => {
      log.error(`Failed to remove PREROUTING bypass rule for iperf3 port ${port}`, err.message);
    });
    await exec(wrapIptables(`sudo iptables -w -D FW_INPUT_ACCEPT -p tcp --dport ${port} -m set --match-set monitored_net_set src,src -m comment --comment "iperf3 wifi test" -j ACCEPT`)).catch((err) => {
      log.error(`Failed to remove INPUT accept rule for iperf3 port ${port}`, err.message);
    });
  }

  async readStoredBypassPort() {
    const content = await fsp.readFile(BYPASS_PORT_FILE, 'utf8').catch(() => null);
    if (!content) return null;
    const port = parseInt(content.trim());
    return isNaN(port) ? null : port;
  }

  async writeStoredBypassPort(port) {
    await fsp.writeFile(BYPASS_PORT_FILE, String(port));
  }

  async clearStoredBypassPort() {
    await fsp.unlink(BYPASS_PORT_FILE).catch(() => {});
  }

  async getPID() {
    const pid = await fsp.readFile(PID_FILE, {"encoding": "utf8"}).then((content) => content.trim().replace('\0', '')).catch((err) => null); // there is a trailing null character in iperf3's pid file
    if (pid) {
      const comm = await fsp.readFile(`/proc/${pid}/comm`, {"encoding": "utf8"}).then((content) => content.trim()).catch((err) => null);
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
    const listenAddr = await exec(`sudo lsof -n -p ${pid} | grep LISTEN | awk '{print $9}'`).then((result) => result.stdout.trim()).catch((err) => null);
    if (listenAddr)
      return listenAddr.split(':')[1];
    return null;
  }
}

module.exports = Iperf3Sensor;