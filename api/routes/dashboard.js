/*    Copyright 2018-2019 Firewalla INC
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

const express = require('express');
const router = express.Router();
const log = require('../../net2/logger.js')(__filename, 'info');
const rclient = require('../../util/redis_manager.js').getRedisClientWithDB1();
const HostTool = require('../../net2/HostTool');
const hostTool = new HostTool();

/* GET home page. */
router.get('/json/stats.json', async (req, res, next) => {
    const keys = await rclient.keysAsync('assets:status:*');
    const stations = [];
    for (const key of keys) {
        try {
            const station_str = await rclient.getAsync(key);
            const station = JSON.parse(station_str);
            const mac = station.mac_addr.toUpperCase();
            const entry = await hostTool.getMACEntry(mac);
            const ip = entry.ipv4;
            const name = hostTool.getHostname(entry);
            station.ip = ip;
            station.name = name;
            stations.push(station);
        } catch(err) {
            log.error("Got error when process station: " + key + " " + err);
        }
    }
    res.json({
        "stations": stations
    });
});

module.exports = router;
