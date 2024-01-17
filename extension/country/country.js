/*    Copyright 2021-2024 Firewalla Inc.
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
const log = require('../../net2/logger.js')(__filename);
const f = require('../../net2/Firewalla.js');
global.geodatadir = `${__dirname}/data`;
const geoip = require('../../vendor_lib/geoip-lite/geoip');
const sem = require('../../sensor/SensorEventManager.js').getInstance();
const { fileExist } = require('../../util/util.js')
let instance = null;
class Country {
    countryDataFolder = `${f.getRuntimeInfoFolder()}/countryData`;

    constructor() {
        if (instance == null) {
            instance = this;
            this.geoip = geoip;
            sem.on('GEO_DAT_CHANGE', (event) => {
                this.updateGeodatadir(event.dir)
            });
            sem.on('GEO_REFRESH', (event) => {
                this.reloadDataSync(event.dataType)
            });
            this.checkDBFiles().then(exist => {
              if (exist) {
                this.updateGeodatadir(this.countryDataFolder)
                this.reloadDataSync()
              }
            })
        }
        return instance;
    }

    async checkDBFiles() {
      return await fileExist(`${this.countryDataFolder}/geoip-country.dat`)
          && await fileExist(`${this.countryDataFolder}/geoip-country6.dat`)
    }

    getCountry(ip) {
        try {
            const result = this.geoip.lookup(ip);
            if (result) {
                return result.country;
            }
        } catch (err) {
            log.error(`Error occured while looking up country data of ${ip}`, err.message);
        }
        return null;
    }
    reloadDataSync(type) {
        this.geoip.reloadDataSync(type)
    }
    updateGeodatadir(dir) {
        if (!dir) return
        this.geoip.updateGeodatadir(dir)
    }
}

module.exports = new Country();
