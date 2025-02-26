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
let expect = chai.expect;
const fs = require('fs');
const BloomFilter = require('../vendor_lib/bloomfilter.js').BloomFilter;
const zlib = require('zlib');
const Promise = require('bluebird');
const urlhash = require("../util/UrlHash.js");

const log = require('../net2/logger.js')(__filename);

Promise.promisifyAll(fs);
const inflateAsync = Promise.promisify(zlib.inflate);

describe('Test intel local cache', function() {
    beforeEach((done) => {
      done();
    });

    afterEach((done) => {
      done();
    });

    it('should load bf data', async() =>{
        const content = await fs.readFileAsync("/home/pi/.firewalla/run/cache/gsb:bloomfilter:compressed", {encoding: "utf8"});
        const buf = Buffer.from(content, 'base64');
        const payload = (await inflateAsync(buf)).toString();
        const bf = new BloomFilter(JSON.parse(payload), 16);
        const hashes = urlhash.canonicalizeAndHashExpressions("www.firewalla.com");
        const hex = Buffer.from(hashes[1], 'base64').toString('hex')
        log.debug("bf test fail", bf.test(hex));
    });
});