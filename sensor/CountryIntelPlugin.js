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

const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const cc = require('../extension/cloudcache/cloudcache.js');
const sem = require('./SensorEventManager.js').getInstance();
const zlib = require('zlib');
const fsp = require('fs').promises
const countryDataFolder = require('../extension/country/country.js').countryDataFolder
const inflateAsync = require('util').promisify(zlib.inflate);
const Buffer = require('buffer').Buffer;

const hashData = [{
    hashKey: "mmdb:ipv4",
    dataPath: `${countryDataFolder}/geoip-country.dat`,
    type: "ipv4"
}, {
    hashKey: "mmdb:ipv6",
    dataPath: `${countryDataFolder}/geoip-country6.dat`,
    type: "ipv6"
}]
const featureName = "country";
class CountryIntelPlugin extends Sensor {
    async run() {
        this.hookFeature(featureName);
    }
    async globalOn() {
        const geoDatChangeEvent = {
            type: 'GEO_DAT_CHANGE',
            dir: countryDataFolder,
            suppressEventLogging: false
        }
        sem.emitLocalEvent(geoDatChangeEvent);
        sem.sendEventToFireApi(geoDatChangeEvent);
        for (const item of hashData) {
            try {
                await cc.enableCache(item.hashKey, (data) => {
                    this.updateCountryData(item, data);
                });
            } catch (err) {
                log.error("Failed to process country data:", item.hashKey);
            }
        }
    }
    // update country data and use in geoip-lite
    async updateCountryData(item, content) {
        try {
            if (!content || content.length < 10) {
                // likely invalid, return null for protection
                log.error(`Invalid country data content for ${item.hashKey}, ignored`);
                return;
            }
            const buf = Buffer.from(content, 'base64');
            const data = await inflateAsync(buf);
            await fsp.writeFile(item.dataPath, data);
            log.info(`Loaded Country Data ${item.hashKey} successfully.`);
            const geoRefreshEvent = {
                type: 'GEO_REFRESH',
                dataType: item.type,
                suppressEventLogging: false
            }
            sem.emitLocalEvent(geoRefreshEvent);
            sem.sendEventToFireApi(geoRefreshEvent);
        } catch (err) {
            log.error("Failed to update country data, err:", err);
        }
    }
    async globalOff() {
        for (const item of hashData) {
            await cc.disableCache(item.hashKey);
        }
        const geoDatChangeEvent = {
            type: 'GEO_DAT_CHANGE',
            dir: null,
            suppressEventLogging: false
        }
        sem.emitLocalEvent(geoDatChangeEvent);
        sem.sendEventToFireApi(geoDatChangeEvent);
        const geoRefreshEvent = {
            type: 'GEO_REFRESH',
            dataType: null,
            suppressEventLogging: false
        }
        sem.emitLocalEvent(geoRefreshEvent);
        sem.sendEventToFireApi(geoRefreshEvent);

    }
}

module.exports = CountryIntelPlugin;
