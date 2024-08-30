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

const PID_FILE = `${f.getRuntimeInfoFolder()}/iperf3.pid`;

class Iperf3Sensor extends Sensor {
  async apiRun() {
    extensionManager.onCmd("iperf3:start", async (msg, data) => {
      let pid = await this.getPID();
      if (!pid)
        pid = await this.startIperf3Server();
      if (!pid)
        throw {msg: `Failed to start iperf3 server`, code: 500};
      const port = await this.getPort(pid);
      if (!port || isNaN(port))
        throw {msg: `Failed to start iperf3 server`, code: 500};
      return {port: Number(port)};
    });

    extensionManager.onCmd("iperf3:stop", async (msg, data) => {
      await this.stopIperf3Server();
      return;
    })
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