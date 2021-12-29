/*    Copyright 2021 Firewalla Inc.
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
const rclient = require('../util/redis_manager.js').getRedisClient()

const _ = require('lodash')

const KEY_PREFIX = 'profile:'
const KEY_LIST = 'profile_list'

class Profile {

  // static methods

  static default = {
    alarm: {
      av: { duMin: 60, rbMin: 5000000 },
      porn: { duMin: 20, rbMin: 1000000, ctMin: 3 },
      games: { duMin: 3, rbMin: 30000, ctMin: 3 },
      vpn: { duMin: 120, rbMin: 10000, ctMin: 3 },
      abnormal: { txInMin: 1000000, txOutMin: 500000, sdMin: 8, ratioMin: 1, ratioSingleDestMin: 1.5, rankedMax: 5 },
    },
  }

  static async list() {
    return rclient.smembersAsync(KEY_LIST)
  }

  static async get(name, path) {
    log.debug('get', name, path)
    const str = await rclient.getAsync(KEY_PREFIX + name)
    if (!str) return {}

    const p = JSON.parse(str)
    if (path)
      return _.get(p, path, {})
    else
      return p
  }

  static async getAll(path) {
    log.debug('getAll', path)
    const list = await this.list()
    const results = {}
    for (const name of list) {
      const obj = await Profile.get(name, path)
      results[name] = obj
    }
    return results
  }

  static async set(name, obj) {
    log.debug('set', name, obj)
    await rclient.saddAsync(KEY_LIST, name)
    await rclient.setAsync(KEY_PREFIX + name, JSON.stringify(obj))
  }

  static async remove(name) {
    log.debug('remove', name)
    await rclient.sremAsync(KEY_LIST, name)
    await rclient.delAsync(KEY_PREFIX + name)
  }


  // instance methods

  // constructor(name, obj, path) {
  //   if (!name) throw new Error('No name provided')

  //   Object.assign(this.value, obj)
  //   if (path) this.path = path
  // }

  // get(path) {
  //   if (!path) return this.value

  //   return _.get(this, path)
  // }

  // async save() {
  //   if (this.path) {
  //     throw new Error('Not Implemented')
  //   }
  //   const args = [ 'profile:' + this.name ]
  //   await rclient.hmsetAsync('profile:' + this.name, JSON.stringify(this)) // functions are ommit here
  // }
}


module.exports = Profile
