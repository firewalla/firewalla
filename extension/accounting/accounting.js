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
const f = require('../../net2/Firewalla.js');
const _ = require('lodash');

/*
 * interval: 1 min => each bit in the redis bit string
 * each bucket is one day
 * so each bucket should have 1440 bit
 * if the bit is 1, it means the user is doing this kind of activity (watching youtube for example) in that minute
 *
 * when querying buckets, it should take timezone into consideration
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

  getAccountListKey(type) {
    return `accounting:${type}:list`; // type: category/app
  }

  async getAccountList(type) {
    const list = await rclient.smembersAsync(this.getAccountListKey(type));
    return list;
  }

  async _record(mac, tag, bucket, beginBit, endBit) {
    const key = this.getKey(mac, tag, bucket);
    for (let i = beginBit; i <= endBit && i <= this.bits; i++) {
      await rclient.setbitAsync(key, i, 1);
    }
  }

  async _count(mac, tag, bucket, begin, end) {
    const key = this.getKey(mac, tag, bucket);
    return rclient.bitcountAsync(key, Math.round(begin), Math.round(end)); // begin and end should be between 0 - this.bits / 8 => 180
  }

  // begin, end - timestamps
  async record(mac, type, tag, begin, end) {
    if (!f.isDevelopmentVersion()) return;
    const beginBucket = Math.floor(begin / this.bucketRange);
    const beginBit = Math.floor((begin - beginBucket * this.bucketRange) / this.step);
    const endBucket = Math.floor(end / this.bucketRange);
    const endBit = Math.floor((end - endBucket * this.bucketRange) / this.step);

    // log.info(mac, tag, beginBucket, beginBit, endBucket, endBit);

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
    await rclient.saddAsync(this.getAccountListKey(type), tag);
  }

  async count(mac, tag, begin, end) {
    const beginBucket = Math.floor(begin / this.bucketRange);
    const beginBit = Math.floor((begin - beginBucket * this.bucketRange) / this.step);
    const endBucket = Math.floor(end / this.bucketRange);
    const endBit = Math.floor((end - endBucket * this.bucketRange) / this.step);

    //    log.info(mac, tag, beginBucket, beginBit, endBucket, endBit);

    let count = 0;

    for (let i = beginBucket; i <= endBucket; i++) {
      let _count = 0;
      if (i === beginBucket && i === endBucket) { // mostly should be this case
        _count = await this._count(mac, tag, i, beginBit / 8, endBit / 8);
      } else if (i === beginBucket) {
        _count = await this._count(mac, tag, i, beginBit / 8, this.bits / 8);
      } else if (i === endBucket) {
        _count = await this._count(mac, tag, i, 0, endBit / 8);
      } else {
        _count = await this._count(mac, tag, i, 0, this.bits / 8);
      }
      count += _count;
    }

    return count;
  }


  pad(num, size) {
    num = num.toString(2);
    while (num.length < size) num = "0" + num;
    return num;
  }

  // convert redis bit string (hex output) to bit string in nodejs, each array item represents 1 min
  redisStringToBitArray(str) {
    var array = [];
    const maxStrLen = this.bits / 8; // each char in the string represents 8 bits
    for (let i = 0; i < maxStrLen; i++) {
      if (i < str.length) {
        let ch = str.charCodeAt(i) & 0xff; // 0xff is important to only use the last 8bits of the char (it was 0-65535)
        let padCH = this.pad(ch, 8); // add leading 0 if needed
        for (const cc of padCH) {
          array.push(Number(cc));
        }
      } else { // if the string stored in redis is a sub string
        array.push(...[0, 0, 0, 0, 0, 0, 0, 0]);
      }
    }
    return array;
  }

  groupBits(array) { // every 5 mins
    let groupedArray = [];
    var i, j, temparray, chunk = 5;
    for (i = 0, j = array.length; i < j; i += chunk) {
      temparray = array.slice(i, i + chunk);
      groupedArray.push(temparray.reduce((a, b) => a + b, 0))
    }
    return groupedArray;
  }

  // begin, end - bit location
  async _detail(mac, tag, bucket, begin, end) {
    const key = this.getKey(mac, tag, bucket);
    const value = await rclient.getAsync(key);
    const resultLen = end - begin;

    if (value == null) { // no such key in redis, return the same size of array filled with 0
      return Array.apply(null, Array(resultLen)).map(Number.prototype.valueOf, 0);
    } else {
      const bitArray = this.redisStringToBitArray(value);
      return bitArray.slice(begin, end);
    }
  }

  async detail(mac, tag, begin, end) {
    const beginBucket = Math.floor(begin / this.bucketRange);
    const beginBit = Math.floor((begin - beginBucket * this.bucketRange) / this.step);
    const endBucket = Math.floor(end / this.bucketRange);
    const endBit = Math.floor((end - endBucket * this.bucketRange) / this.step);

    let output = [];

    for (let i = beginBucket; i <= endBucket; i++) {
      let _output = [];
      if (i === beginBucket && i === endBucket) { // mostly should be this case
        _output = await this._detail(mac, tag, i, beginBit, endBit);
      } else if (i === beginBucket) {
        _output = await this._detail(mac, tag, i, beginBit, this.bits);
      } else if (i === endBucket) {
        _output = await this._detail(mac, tag, i, 0, endBit);
      } else {
        _output = await this._detail(mac, tag, i, 0, this.bits);
      }
      output.push(..._output);
    }

    return output;
  }

  async hourlyDetail(mac, tag, begin, hourCount) {
    const end = begin + hourCount * 3600 * 1000;
    const bitArray = await this.detail(mac, tag, begin, end);

    const rawHourlyBitArray = _.chunk(bitArray, 60)

    const resultArray = [];

    for (const hourArray of rawHourlyBitArray) {
      resultArray.push(hourArray.reduce((a, b) => a + b, 0))
    }
    return resultArray;
  }
}

module.exports = new Accounting();