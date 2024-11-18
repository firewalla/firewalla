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
const Message = require('../net2/Message.js');

const sem = require('./SensorEventManager.js').getInstance();

const ZEEK_SIG_FILE = `${f.getRuntimeInfoFolder()}/zeek_signatures/dpi.sig`;

class ZeekDPISensor extends Sensor {
  async run() {
    this.sigFileWatcher = null;
    const reloadJob = new scheduler.UpdateJob(this.initFileWatcher.bind(this), 5000);
    this.reloadJob = reloadJob;
    await reloadJob.exec();
  }

  initFileWatcher() {
    if (this.sigFileWatcher)
      this.sigFileWatcher.close();
    const watcher = fs.watch(ZEEK_SIG_FILE, (eventType, filename) => {
      sem.emitLocalEvent({ type: Message.MSG_PCAP_RESTART_NEEDED });
      if (eventType === "rename")
        this.reloadJob.exec();
    });
    watcher.on('error', (err) => {
      log.error("Error occured in signature file watcher", err);
      this.reloadJob.exec();
    });
    this.sigFileWatcher = watcher;
  }
}

module.exports = ZeekDPISensor;