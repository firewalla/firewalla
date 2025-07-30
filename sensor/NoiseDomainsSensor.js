/*    Copyright 2016-2023 Firewalla Inc.
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

const Sensor = require('./Sensor.js').Sensor;

const fs = require('fs');
const scheduler = require('../util/scheduler.js');
const f = require('../net2/Firewalla.js');
const _ = require('lodash');
const readline = require('readline');
const { Address4, Address6 } = require('ip-address');
const DomainTrie = require('../util/DomainTrie.js');
const BloomFilterManager = require('../util/BloomFilterManager.js')
const { exec } = require('child-process-promise')

let DOMAINS_DIR = `${f.getRuntimeInfoFolder()}/noise_domains`;

class NoiseDomainsSensor extends Sensor {
  async run() {
    return this.init();
  }

  async apiRun() {
    return this.init();
  }
  
  async init() {
    if (this.config.domainsDirectory)
      DOMAINS_DIR = this.config.domainsDirectory;
    await exec(`mkdir -p ${DOMAINS_DIR}`)
    this.domainsTrie = new DomainTrie();
    this.bloomFilterManager = new BloomFilterManager(4 * 1024 * 1024, 17); 
    const reloadJob = new scheduler.UpdateJob(this.reloadDomains.bind(this), 5000);
    await reloadJob.exec();
    fs.watch(DOMAINS_DIR, (eventType, filename) => {
      log.info(`${filename} under ${DOMAINS_DIR} is ${eventType}, will reload noise domains ...`);
      reloadJob.exec();
    });
  }

  async reloadDomains() {
    const startTime = Date.now();
    this.bloomFilterManager.reset();
    await this.bloomFilterManager.loadFromDirectory(DOMAINS_DIR);
    // await this.reloadDomainTries();

    log.info(`Noise domain reconstruction complete in ${Date.now() - startTime} ms`);
  }

  async reloadDomainTries() {
    const files = await fs.promises.readdir(DOMAINS_DIR).catch((err) => {
      log.error(`Failed to read noise domains directory ${DOMAINS_DIR}`, err.message);
      return null;
    });
    if (_.isArray(files)) {
      this.domainsTrie.clear();
      for (const file of files) {
        await new Promise((resolve, reject) => {
          const reader = readline.createInterface({
            input: fs.createReadStream(`${DOMAINS_DIR}/${file}`)
          });
          reader.on('line', (data) => {
            if (data.includes('*')) {
              this.domainsTrie.add(data, file); // filename is the value of the domain
            }
          });
          reader.on('close', () => {
            resolve();
          });
        });
        log.info(`Noise config file ${file} is reloaded`);
      }
    }
    log.info(`Noise domain trie reconstruction complete`);
  }

  find(domain, isIP = false) {
    if (isIP) {
      return this.bloomFilterManager.find(domain);
    }
    const reversedParts = domain.split('.').reverse();
    for (let i = reversedParts.length - 1; i >= 0; i--) {
      const subDomain = reversedParts.slice(0, i + 1).reverse().join('.');
      const result = this.bloomFilterManager.find(subDomain);
      if (!_.isEmpty(result)) {
        return result;
      }
    }
    return this.domainsTrie.find(domain) ;
  }

}

module.exports = NoiseDomainsSensor;
