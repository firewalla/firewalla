/*    Copyright 2022 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program. If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const f = require('../net2/Firewalla.js');
const fc = require('../net2/config.js')
const sclient = require('../util/redis_manager.js').getSubscriptionClient()

const fs = require('fs')
const fsp = fs.promises
const exec = require('child-process-promise').exec
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();

const lockSysPatch = 'LOCK_SYSPATCH'

const assetFilePath = `${f.getHiddenFolder()}/run/assets.d/10_patch.lst`
const crontabFilePath = `${f.getHiddenFolder()}/config/crontab/sys_patch`
const featureName = 'sys_patch'

/* How things work here
 * 1. gets hotfix list from cloudConfig
 * 2. convert the list to hotfix.lst under ~/.firewalla/run/assets.d
 * 3. cronjob invokes update_assets.sh and drop packages under /data/patch/deb/
 * 4. generated crontab (~/.firewalla/run/crontab/sys_patch) calls patch_system.sh
 *    eventually installs all packages under /data/patch/deb/
 */

class SysPatchSensor extends Sensor {
  async run() {
    this.hookFeature(featureName)
    // save binded version for removeListener()
    this.eventListener = this.configListener.bind(this)
  }

  configListener(channel, _) {
    if (channel == 'config:updated') {
      // config:updated always published from main, no need to parse message here
      this.checkConfig(fc.getConfig())
    }
  }

  async globalOn() {
    super.globalOn()
    this.checkConfig(fc.getConfig())

    sclient.subscribe('config:updated')
    sclient.on("message", this.eventListener)

    await fsp.writeFile(crontabFilePath, '0 1 * * * ( sleep $(( ${RANDOM} * 60 / 32768 ))m ; timeout 1200 /home/pi/firewalla/scripts/patch_system.sh >/dev/null 2>&1 )\n')
    await exec(`${f.getFirewallaHome()}/scripts/update_crontab.sh`);
  }

  async globalOff() {
    super.globalOff()
    sclient.removeListener("message", this.eventListener)

    await fsp.unlink(crontabFilePath)
    await exec(`${f.getFirewallaHome()}/scripts/update_crontab.sh`);
  }

  checkConfig(config) {
    lock.acquire(lockSysPatch, async() => {
      log.debug('checkConfig')
      const newList = config && config.hotfix
      if (!newList || JSON.stringify(newList) == JSON.stringify(this.listWritten)) return

      await this.writeAssetsFile(newList)
    }).catch(err => {
      log.error(err)
    })
  }

  async writeAssetsFile(list) {
    if (!Array.isArray(list) || !list.length) return

    try {
      const lines = list.map(p => `/data/patch/deb/${p.name} ${p.remotePath} ${p.remotePath}.sha256 644\n`)

      log.debug(lines)

      await fsp.writeFile(assetFilePath, lines.join(''))
      this.listWritten = list
    } catch(err) {
      log.error('Error writing patch file', err)
    }
  }
}

module.exports = SysPatchSensor
