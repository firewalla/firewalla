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
const f = require('../net2/Firewalla.js');

const DOMAIN_FOLDER = `${f.getRuntimeInfoFolder()}/noise_domains/`;
const fs = require('fs');

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
    expect(noiseDomainManager.find('example.com').has("noise")).to.be.equal(false);
    expect(noiseDomainManager.find('invalid.domain').has("noise")).to.be.equal(false);


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