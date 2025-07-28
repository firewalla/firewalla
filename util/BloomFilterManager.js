/*    Copyright 2016-2025 Firewalla Inc.
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
const { BloomFilter } = require('../vendor_lib/bloomfilter.js');
const fs = require('fs');
const path = require('path');

class BloomFilterManager {

  _bfMap = new Map();
  _capacity = 4 * 1024 * 1024;; // number of bits to allocate.
  _hashnum = 17; // number of hash functions.

  constructor(capacity, hashnum) {
    this._validateAndSetParams(capacity, hashnum);
    this._bloomFilters = new Map();
  }

  _validateAndSetParams(capacity, hashnum) {
    if (Number.isInteger(capacity) && capacity > 0) {
      this._capacity = capacity;
    }
    if (Number.isInteger(hashnum) && hashnum > 0) {
      this._hashnum = hashnum;
    }
  }

  reset(capacity, hashnum) {
    this._validateAndSetParams(capacity, hashnum);
    this._bloomFilters.clear();
  }

  async loadFromFile(directory, file) {
    const startTime = Date.now();
    const filePath = path.join(directory, file);
    this._bloomFilters.set(file, new BloomFilter(this._capacity, this._hashnum));

    return new Promise((resolve, reject) => {
      fs.readFile(filePath, 'utf8', (err, fileContent) => {
        if (err) return reject(err);
        try {
          const items = fileContent.split('\n').map(line => line.trim()).filter(line => line.length > 0);
          items.forEach(item => {
            this._bloomFilters.get(file).add(item);
          });
          const duration = Date.now() - startTime;
          resolve({ duration, count: items.length });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async loadFromDirectory(directory) {
    const startTime = Date.now();
    const files = await fs.promises.readdir(directory).catch((err) => {
      log.error(`Failed to read noise domains directory ${directory}`, err.message);
      return null;
    });

    let loaded = 0;
    let failed = 0;

    const results = await Promise.allSettled(
      files.map(file =>
        this.loadFromFile(directory,file)
      )
    );

    results.forEach(result => {
      if (result.status === 'fulfilled') loaded++;
      else failed++;
    });

    return { loaded, failed, totalDuration: Date.now() - startTime, totalFilters: this._bloomFilters.size };
  }

  _ensureJsonExtension(filename) {
    return filename.endsWith('.json') ? filename : `${filename}.json`;
  }

  async exportToJsonFile(directory, file) {
    const startTime = Date.now();
    const filename = this._ensureJsonExtension(file);
    const filePath = path.join(directory, filename);

    return new Promise((resolve, reject) => {
      if (!this._bloomFilters.has(file)) {
        return reject(new Error(`Bloom filter for ${file} not found`));
      }

      try {
        const array = Array.from( this._bloomFilters.get(file).buckets);
        fs.writeFile(filePath, JSON.stringify(array), 'utf8', (err) => {
          if (err) return reject(err);
          const duration = Date.now() - startTime;
          resolve({ duration, path: filePath });
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async exportJsonToDirectory(directory) {
    const startTime = Date.now();

    const results = await Promise.allSettled(
      Array.from(this._bloomFilters.entries()).map(([file, filter]) =>
        this.exportToJsonFile(directory, file)
      )
    );

    const successful = results.filter(result => result.status === 'fulfilled');
    const failed = results.filter(result => result.status === 'rejected');

    return {
      total: results.length,
      successful: successful.length,
      failed: failed.length,
      totalDuration: Date.now() - startTime
    };
  }

  async importFromJsonFile(directory, file) {
    const startTime = Date.now();
    const filePath = path.join(directory, file);

    return new Promise((resolve, reject) => {
      fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) return reject(err);
        try {
          const array = JSON.parse(data);
          this._bloomFilters.set(file, new BloomFilter(array, this._hashnum));
          const duration = Date.now() - startTime;
          resolve({ duration });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async importJsonFromDirectory(directory) {
    const startTime = Date.now();
    const files = await fs.promises.readdir(directory).catch((err) => {
      log.error(`Failed to read directory ${directory}`, err.message);
      return null;
    });

    let loaded = 0;
    let failed = 0;

    const results = await Promise.allSettled(
      files.map(file => this.importFromJsonFile(directory, file))
    );

    results.forEach(result => {
      if (result.status === 'fulfilled') loaded++;
      else failed++;
    });

    return { loaded, failed, totalDuration: Date.now() - startTime };
  }

  contains(item) {
    for (const [_, filter] of this._bloomFilters.entries()) {
      if (filter.test(item)) {
        return true; 
      }
    }
    return false;
  }

  find(key) {
    const result = new Set();
    for (const [file, filter] of this._bloomFilters.entries()) {
      if (filter.test(key)) {
        result.add(file);
      }
    }
    return result;
  }

}

module.exports = BloomFilterManager;