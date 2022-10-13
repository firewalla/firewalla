'use strict';

/*    Copyright 2021 Firewalla INC
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

const log = require('../../net2/logger.js')(__filename);

const _ = require('lodash');

const cc = require('../cloudcache/cloudcache.js');

const zlib = require('zlib');
const fs = require('fs');

const Promise = require('bluebird');
const inflateAsync = Promise.promisify(zlib.inflate);
Promise.promisifyAll(fs);

let instance = null;

class bf {
  constructor() {
    if (instance === null) {
      instance = this;
    }

    return instance;
  }
  
  getHashKeyName(item = {}) {
    if(!item.count || !item.error || !item.prefix) {
      log.error("Invalid item:", item);
      return null;
    }

    const {count, error, prefix, level} = item;
    
    if (level) {
      return `bf:${level}_${prefix}:${count}:${error}`;  
    }
    return `bf:${prefix}:${count}:${error}`;
  }

  async updateBFData(item, content, outputFilePath) {
    try {
      if(!content || content.length < 10) {
        // likely invalid, return null for protection
        log.error(`Invalid bf data content for ${item && item.prefix}, ignored`);
        return;
      }
      const buf = Buffer.from(content, 'base64'); 
      const output = await inflateAsync(buf);
      
      await fs.writeFileAsync(outputFilePath, output);
    } catch(err) {
      log.error("Failed to update bf data, err:", err);
    }
  }

  async deleteBFData(outputFilePath) {
    try {
      await fs.unlinkAsync(outputFilePath);
    } catch (err) {
      //
    }
  }
}

module.exports = new bf();
