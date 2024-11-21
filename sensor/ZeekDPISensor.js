/*    Copyright 2016-2023 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const fs = require('fs');
const scheduler = require('../util/scheduler.js');
const f = require('../net2/Firewalla.js');
const _ = require('lodash');
const crypto = require('crypto');
const Message = require('../net2/Message.js');

const sem = require('./SensorEventManager.js').getInstance();

const ZEEK_SIG_DIR = `${f.getRuntimeInfoFolder()}/zeek_signatures`;

class ZeekDPISensor extends Sensor {
  async run() {
    this.sigFileWatcher = null;
    this.sigSha256s = {};
    const reloadJob = new scheduler.UpdateJob(this.initFileWatcher.bind(this), 5000);
    this.reloadJob = reloadJob;

    await reloadJob.exec();
  }

  async initFileWatcher() {
    if (this.sigFileWatcher)
      this.sigFileWatcher.close();
    const watcher = fs.watch(ZEEK_SIG_DIR, async (eventType, filename) => {
      const sha256 = await this.loadSigFileHash(filename);
      if (sha256 !== this.sigSha256s[filename]) {
        log.info(`zeek sig file ${filename} is updated, will restart zeek ...`);
        sem.emitLocalEvent({ type: Message.MSG_PCAP_RESTART_NEEDED });
      }
      this.sigSha256s[filename] = sha256;
    });
    watcher.on('error', (err) => {
      log.error("Error occured in signature file watcher", err);
      this.reloadJob.exec();
    });
    const files = await fs.readdirAsync(ZEEK_SIG_DIR).catch((err) => []);
    for (const file of files)
      this.sigSha256s[file] = await this.loadSigFileHash(file);
    this.sigFileWatcher = watcher;
  }

  async loadSigFileHash(filename) {
    const content = await fs.readFileAsync(`${ZEEK_SIG_DIR}/${filename}`, "utf8").catch((err) => {
      log.error(`Failed to read zeek sig file`, err.message);
      return null;
    });
    if (content) {
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      return sha256;
    }
    return null;
  }
}

module.exports = ZeekDPISensor;