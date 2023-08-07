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

'use strict';
const log = require('../../net2/logger.js')(__filename);
global.geodatadir = `${__dirname}/data`;
const geoip = require('../../vendor_lib/geoip-lite/geoip');
const sem = require('../../sensor/SensorEventManager.js').getInstance();
let instance = null;
class Country {
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
        }
        return instance;
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
        this.geoip.updateGeodatadir(dir ? dir : `${__dirname}/data`)
    }
}

module.exports = new Country();
