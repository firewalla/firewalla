/*    Copyright 2016-2024 Firewalla Inc.
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

'use strict'

let chai = require('chai');
const _ = require('lodash');
let expect = chai.expect;

const NoiseDomainsSensor = require('../sensor/NoiseDomainsSensor.js');
const BloomFilterManager = require('../util/BloomFilterManager.js');
const DomainTrie = require('../util/DomainTrie.js');
const f = require('../net2/Firewalla.js');

const DOMAIN_FOLDER = `${f.getRuntimeInfoFolder()}/noise_domains/`;
const EXPORT_FOLDER = '/tmp';
const fs = require('fs');
// const DOMAIN_FOLDER = `/tmp/bftest/domain`;
// const EXPORT_FOLDER = '/tmp/bftest/json';
const TEST_CAPACITY = 4 * 1024 * 1024; // number of bits to allocate.
const TEST_HASHNUM = 17; // number of hash functions.


describe('Test BloomFilterManager', function () {
  this.timeout(10000);
  beforeEach((done) => {
    done();
  });

  afterEach((done) => {
    done();
  });

  it('should process BloomFilterManager correctly', async () => {
    // Initialize the Bloom Filter Manager
    const bfManager = new BloomFilterManager(TEST_CAPACITY, TEST_HASHNUM);

    console.log('\n--- Step 1: Loading domains from File ---');
    try {
      const loadResult = await bfManager.loadFromDirectory(DOMAIN_FOLDER);
      console.log('Loaded Bloom Filter from', DOMAIN_FOLDER, 'in', loadResult.totalDuration, 'ms');
    } catch (error) {
      console.error('Failed to load domains:', error);
    }
    expect(bfManager.contains('0-000.store')).to.be.equal(true);
    expect(bfManager.find('0-000.store').has('noise')).to.be.equal(true);

    console.log('\n--- Step 2: exporting domain to a json file ---');
    try {
      const exportResult = await bfManager.exportJsonToDirectory(EXPORT_FOLDER);
      console.log('Exported Bloom Filter to', EXPORT_FOLDER, 'in', exportResult.totalDuration, 'ms');
    } catch (error) {
      console.error('Failed to export Bloom Filter:', error);
    }

    console.log('\n--- Step 3: reset bloomfilter ---');
    bfManager.reset();
    expect(bfManager.contains('0-000.store')).to.be.equal(false);
    expect(bfManager.find('0-000.store').size).to.be.equal(0);

    console.log('\n--- Step 3: importing domain to bloomfilter from json file---');
    try {
      const importResult = await bfManager.importJsonFromDirectory(EXPORT_FOLDER);
      console.log('Imported Bloom Filter from', EXPORT_FOLDER, 'in', importResult.totalDuration, 'ms');
    } catch (error) {
      console.error(`Failed to import Bloom Filter: ${error.message}`);
    }

    expect(bfManager.contains('com')).to.be.equal(false);
    expect(bfManager.find('com').size).to.be.equal(0);
    expect(bfManager.contains('0-000.store')).to.be.equal(true);
    expect(bfManager.find('0-000.store').has('noise.json')).to.be.equal(true);
  });

});


describe('Test NoiseDomainsSensor', function () {
  this.timeout(20000);
  beforeEach((done) => {
    done();
  });

  afterEach((done) => {
    done();
  });

  it('should process NoiseDomainsSensor correctly', async () => {
    // Initialize the Bloom Filter Manager
    const noiseDomainManager = new NoiseDomainsSensor();

    console.log('\n--- Step 1: Loading domains from File ---');
    await noiseDomainManager.apiRun();

    expect(noiseDomainManager.find('0-000.store').has("noise")).to.be.equal(true);
    expect(noiseDomainManager.find('test.0-000.store').has("noise")).to.be.equal(true);
    expect(noiseDomainManager.find('example.com')).to.be.equal(null);
    expect(noiseDomainManager.find('invalid.domain')).to.be.equal(null);


    const startTime = Date.now();
    const result = new Promise((resolve, reject) => {
      fs.readFile(`${DOMAIN_FOLDER}/noise`, 'utf8', (err, fileContent) => {
        if (err) return reject(err);
        try {
          const items = fileContent.split('\n').map(line => line.trim()).filter(line => line.length > 0);
          let cnt = 0;
          items.forEach(item => {
            if (noiseDomainManager.find(item).has("noise")) {
              cnt++;
            }
          });
          const duration = Date.now() - startTime;
          resolve({ duration, count: cnt, total: items.length });
        } catch (error) {
          reject(error);
        }
      });
    });

    (async () => {
      try {
        const { duration, count, total } = await result;
        console.log(`Found ${count} noise domains in ${duration} ms`);
        expect(count).to.be.equal(total);
      } catch (error) {
        console.error("Error reading noise domains:", error);
      }
    })();
  });

});