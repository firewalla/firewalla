/*    Copyright 2023 Firewalla Inc.
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
const firewalla = require('../net2/Firewalla.js');
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const Message = require('../net2/Message.js')

const fsp = require('fs').promises

const RETRY_COUNT = 3

class AssetsManager {
  constructor() {
    this.assetsPath = firewalla.getRuntimeInfoFolder() + '/assets/'
    this.files = {}
    this.retry = {}
    fsp.mkdir(this.assetsPath, { recursive: true })
      .catch(err => log.error('Error creating directory', this.assetsPath, err))
    sclient.on("message", async (channel, message) => {
      if (channel == Message.MSG_ASSETS_UPDATED_CHANNEL) {
        log.info(channel, message)
        for (const key in this.files) {
          if (key.startsWith(message)) {
            log.info('Reloading', key)
            delete this.files[key]
            this.files[key] = await this.get(key, true)
          }
        }
        this.retry = {}
      }
    })
    sclient.subscribe(Message.MSG_ASSETS_UPDATED_CHANNEL)
  }

  async get(path, force = false) {
    if (this.files[path])
      return this.files[path]
    else if (!force && this.retry[path] > RETRY_COUNT)
      return {}

    try {
      log.debug('Reading file', this.assetsPath + path)
      const raw = await fsp.readFile(this.assetsPath + path, { encoding: 'utf8' })
      this.files[path] = JSON.parse(raw)
      return this.files[path]
    } catch(err) {
      if (!this.retry[path])
        this.retry[path] = 1
      else
        this.retry[path] ++

      if (err.code == 'ENOENT')
        log.verbose('File not exist', path)
      else
        log.error('Error loading', fileName, err)

      return {}
    }
  }
}

module.exports = new AssetsManager()
