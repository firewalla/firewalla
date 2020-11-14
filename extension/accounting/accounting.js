/*    Copyright 2020 Firewalla INC.
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

let instance = null;

const rclient = require('../../util/redis_manager.js').getRedisClient()
const log = require('../../net2/logger.js')(__filename);

/*
 * interval: 1 min => each bit in the redis bit string
 * each bucket is one day
 * so each bucket should have 1440 bit
 * if the bit is 1, it means the user is doing this kind of activity (watching youtube for example) in that minute
 */
class Accounting {
  constructor() {
    if (instance === null) {
      this.step = 60 * 1000; // every minute as a slot           
      this.bits = 24 * 60;
      this.bucketRange = this.step * this.bits;
      instance = this;
    }

    return instance;
  }

  getKey(mac, tag, bucket) {
    return `accounting:${mac}:${tag}:${bucket}`
  }


  async _record(mac, tag, bucket, beginBit, endBit) {
    const key = this.getKey(mac, tag, bucket);
    for (let i = beginBit; i <= endBit && i <= this.bits; i++) {
      await rclient.setbitAsync(key, i, 1);
    }
  }

  async _count(mac, tag, bucket) {
    const key = this.getKey(mac, tag, bucket);
    return rclient.bitcountAsync(key);
  }

  // begin, end - timestamps
  async record(mac, tag, begin, end) {
    const beginBucket = Math.floor(begin / this.bucketRange);
    const beginBit = Math.floor((begin - beginBucket * this.bucketRange) / this.step);
    const endBucket = Math.floor(end / this.bucketRange);
    const endBit = Math.floor((end - endBucket * this.bucketRange) / this.step);

    log.info(beginBucket, beginBit, endBucket, endBit);

    for (let i = beginBucket; i <= endBucket; i++) {
      if (i === beginBucket && i === endBucket) { // mostly should be this case
        await this._record(mac, tag, i, beginBit, endBit);
      } else if (i === beginBucket) {
        await this._record(mac, tag, i, beginBit, this.bits);
      } else if (i === endBucket) {
        await this._record(mac, tag, i, 0, endBit);
      } else {
        await this._record(mac, tag, i, 0, this.bits);
      }
    }
  }

  async count(mac, tag, begin, end) {
    const beginBucket = Math.floor(begin / this.bucketRange);
    const beginBit = Math.floor((begin - beginBucket * this.bucketRange) / this.step);
    const endBucket = Math.floor(end / this.bucketRange);
    const endBit = Math.floor((end - endBucket * this.bucketRange) / this.step);

    log.info(beginBucket, beginBit, endBucket, endBit);

    let count = 0;

    for (let i = beginBucket; i <= endBucket; i++) {
      const _count = await this._count(mac, tag, i);
      count += _count;      
    }

    return count;
  }
}

module.exports = new Accounting();