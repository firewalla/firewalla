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
 * 
 * when creating buckets, it should take timezone into consideration
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

  async _count(mac, tag, bucket, begin, end) {
    const key = this.getKey(mac, tag, bucket);
    return rclient.bitcountAsync(key, begin, end); // begin and end should be between 0 - this.bits / 8 => 180
  }

  // begin, end - timestamps
  async record(mac, tag, begin, end) {
    const beginBucket = Math.floor(begin / this.bucketRange);
    const beginBit = Math.floor((begin - beginBucket * this.bucketRange) / this.step);
    const endBucket = Math.floor(end / this.bucketRange);
    const endBit = Math.floor((end - endBucket * this.bucketRange) / this.step);

    log.info(mac, tag, beginBucket, beginBit, endBucket, endBit);

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

    log.info(mac, tag, beginBucket, beginBit, endBucket, endBit);

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

  stringToBytes ( str ) {
    var ch, st, re = [];
    for (var i = 0; i < str.length; i++ ) {
      ch = str.charCodeAt(i);  // get char 
      st = [];                 // set up "stack"
      do {
        st.push( ch & 0xFF );  // push byte to stack
        ch = ch >> 8;          // shift value down by 1 byte
      }  
      while ( ch );
      // add stack contents to result
      // done because chars have "wrong" endianness
      re = re.concat( st.reverse() );
    }
    // return an array of bytes
    return re;
  }

decbin(dec,length){
  var out = "";
  while(length--)
    out += (dec >> length ) & 1;
  return out;
}

  async _detail(mac, tag, bucket, begin, end) {
    const key = this.getKey(mac, tag, bucket);
    const value = await rclient.getAsync(key);
    let binaryOutput = "";
    if(value == null) {
	    binaryOutput = "0".repeat((end-begin) * 2)
    log.info("_detail", mac, tag, bucket, begin, end, binaryOutput);
	    return binaryOutput;
	    }
    const byteArray = this.stringToBytes(value); // each byte takes one element in the array
    for(let i = 0; i < end; i++) {
      if(i >= begin && i < byteArray.length) {
	      let hex = byteArray[i].toString(16);
	      if(hex.length == 1)  {
		      hex = "0" + hex;
	      }
	      binaryOutput += hex;
        //binaryOutput += this.decbin(byteArray[i], 8);
	    log.info("XXXXXXXXXX", hex);
      } else if (i >= begin) {
	binaryOutput += "00"
	    log.info("XXXXXXXXXX", "00");
      }
    }
    log.info("_detail", mac, tag, bucket, begin, end, binaryOutput);
    return binaryOutput;
  }

  async detail(mac, tag, begin, end) {
    const beginBucket = Math.floor(begin / this.bucketRange);
    const beginBit = Math.floor((begin - beginBucket * this.bucketRange) / this.step);
    const endBucket = Math.floor(end / this.bucketRange);
    const endBit = Math.floor((end - endBucket * this.bucketRange) / this.step);

    log.info(mac, tag, beginBucket, beginBit, endBucket, endBit);

    let output = 0;

    for (let i = beginBucket; i <= endBucket; i++) {
      let _output = 0;
      if (i === beginBucket && i === endBucket) { // mostly should be this case
        _output = await this._detail(mac, tag, i, Math.floor(beginBit / 8), Math.floor(endBit / 8));
      } else if (i === beginBucket) {
        _output = await this._detail(mac, tag, i, Math.floor(beginBit / 8), Math.floor(this.bits / 8));
      } else if (i === endBucket) {
        _output = await this._detail(mac, tag, i, 0, Math.floor(endBit / 8));
      } else {
        _output = await this._detail(mac, tag, i, 0, Math.floor(this.bits / 8));
      }
      output += _output;
    }

    return output;
  }
}

module.exports = new Accounting();
