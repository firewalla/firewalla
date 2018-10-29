'use strict';

/*    Copyright 2016 Firewalla LLC / Firewalla LLC
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

let instance = null;

const log = require('../net2/logger.js')(__filename);

const f = require('../net2/Firewalla.js');

const configFile = `${f.getFirewallaHome()}/config.web.config`;

const cloud = require('../encipher');
const Promise = require('bluebird');

const jsonfile = require('jsonfile');
const readFileAsync = Promise.promisify(jsonfile.readFile);

class FireWeb {

  constructor() {
    if(instance === null) {
      instance = this;
    }

    return instance;
  }

  async getCloudInstance() {
    try {
      const config = await readFileAsync(configFile);
      const name = config.name || "firewalla_web";
      const eptCloud = new cloud(name, null);
      await eptCloud.loadKeys();
      return eptCloud;
    } catch(err) {
      log.error(`Failed to load config from file ${configFile}: ${err}`);
      return null;
    }
  }

  getWebToken() {

  }
}

module.exports = FireWeb;