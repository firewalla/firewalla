/*    Copyright 2016 Firewalla LLC 
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

const rp = require('request-promise');
const f = require('../net2/Firewalla.js');
const fConfig = require('../net2/config.js').getConfig();
const fs = require('fs');
const jwtlib = require('jsonwebtoken');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const log = require('../net2/logger.js')(__filename);

class FWTokenManager {
  constructor() {
    if(instance === null) {
      instance = this;
      this.pubKeys = [];
      this.localFolder = null;
    }

    return instance;
  }

  async loadPubKeys() {
    this.pubKeys = [];
    const localContents = await this.loadLocalPublicKeys();
    this.pubKeys.push.apply(this.pubKeys, localContents);

    const remoteContents = await this.loadRemotePublicKeys();
    this.pubKeys.push.apply(this.pubKeys, remoteContents);
  }

  // LOCAL
  getLocalPubKeysFolder() {
    return this.localFolder || `${f.getFirewallaHome()}/etc/keys`;
  }

  async loadLocalPublicKeys() {
    const localFolder = this.getLocalPubKeysFolder();

    try {
      await fs.statAsync(localFolder);

      const filenames = await fs.readdirAsync(localFolder);

      const filepaths = filenames.map((filename) => {
        return `${localFolder}/${filename}`;
      });

      const contents = await Promise.all(filepaths.map(async (filepath) => {
        return fs.readFileAsync(filepath, {encoding: 'utf8'})
      }))

      return contents;

    } catch(err) {
      if(err.code === 'ENOENT') {
        log.info("Local pub key folder not exists:", localFolder);
        return null; // folder not exist
      } else {
        log.error("Got error when accessing local pub key folder:", err);
        return null;
      }
    }
    
  }   

  // REMOTE
  getRemotePubKeyURLs() {
    return fConfig.pubKeys;
  }

  async getRemotePubKey(url) {
    return await rp(url);
  }

  async loadRemotePublicKeys() {
    const urls = this.getRemotePubKeyURLs();
    return Promise.all(urls.map(async (url) => {
      return this.getRemotePubKey(url);
    }));
  }

  // NOT USED YET
  async getPublicKeysCacheFolder() {
    const folder = `${f.getHiddenFolder()}/pubKeys`;
  }

  // TOKEN VERIFICATION
  verify(token) {
    if(this.pubKeys.length > 0) {
      const results = this.pubKeys.filter((key) => {
        try {
          const decoded = jwtlib.verify(token, key);
          console.log(decoded);
          return true;
        } catch(err) {
          log.error("Failed to verify token with key:", err);
          return false;
        }        
      });

      return true;
    } else {
      return false;
    }
  }
}

module.exports = new FWTokenManager();