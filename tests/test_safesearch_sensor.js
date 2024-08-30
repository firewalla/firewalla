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

let log = require('../net2/logger.js')(__filename, 'info');
const execAsync = require('child-process-promise').exec;

const SafeSearchPlugin = require('../sensor/SafeSearchPlugin.js');

const ssconfig = {
  "mapping": {
    "youtube_strict": {
      "restrict.youtube.com": [
        "www.youtube.com",
        "m.youtube.com",
        "youtubei.googleapis.com",
        "youtube.googleapis.com",
        "www.youtube-nocookie.com"
      ]
    },
    "youtube_moderate": {
      "restrictmoderate.youtube.com": [
        "www.youtube.com",
        "m.youtube.com",
        "youtubei.googleapis.com",
        "youtube.googleapis.com",
        "www.youtube-nocookie.com"
      ]
    },
    "google": {
      "forcesafesearch.google.com": [
        "www.google.com",
        "www.google.ac",
        "www.google.cat"
      ]
    },
    "bing": {
      "strict.bing.com": [
        "www.bing.com"
      ]
    },
    "duckduckgo": {
      "safe.duckduckgo.com": [
        "duckduckgo.com"
      ]   
    }
  },
  "mappingConfig": {
    "safe.duckduckgo.com": 5
  },
  "defaultConfig": {
    "youtube": "off",
    "google": "on",
    "bing": "on",
    "duckduckgo": "on"
  }
};

describe('Test safe search', function(){
    this.timeout(30000);

    before((done) => {
      this.plugin = new SafeSearchPlugin(ssconfig);
      done();
    });

    after((done) => {
      done();
    });

    it('should generate cname entries', async()=> {
        const entries = this.plugin.generateCnameEntry('safe.example.com', ['example.com','wwww.example.com','extension.example.com']);
        expect(entries[0]).to.equal('cname=example.com,wwww.example.com,extension.example.com,safe.example.com$safe_search');
    });

    it('should get all domains', async()=> {
      const domains = await this.plugin.getAllDomains();
      expect(domains).to.eql(["restrict.youtube.com","restrictmoderate.youtube.com","forcesafesearch.google.com","strict.bing.com","safe.duckduckgo.com"]);
    });

  });
  


  describe('generate domain entries', function(){
    this.timeout(30000);

    beforeEach((done) => {
      this.plugin = new SafeSearchPlugin(ssconfig);
      done();
    });
  
    afterEach((done) => {
      done();
    });

    it('should generate domain entries', async()=> {
      const entries = await this.plugin.generateDomainEntries("safe.duckduckgo.com", ["duckduckgo.com"]);
      expect(entries[0]).to.equal('cname=duckduckgo.com,safe.duckduckgo.com$safe_search');
    });

    it('should generate address entries', async()=> {
      const entries = await this.plugin.generateDomainEntries("forcesafesearch.google.com", ["www.google.com"]);

      const result = await execAsync(`redis-cli zrevrange rdns:domain:forcesafesearch.google.com 0 0`);
      const match = result.stdout.trim();
      expect(entries[0]).to.include(`/www.google.com/${match}$safe_search`);
    });

  });