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

var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/json/stats.json', async (req, res, next) => {
    res.json({
        "stations": [
            {
                "name": "MyPhone",
                "mac_addr": "4a:90:f0:42:1a:a2",
                "ip": "192.168.245.11",
                "ssid": "SGold203",
                "tx_rate": 573,
                "rx_rate": 2401,
                "rssi": -31,
                "snr": 64,
                "assoc_time": 33067,
                "channel": 48,
                "apMac": "20:6d:31:bb:00:00",
                "ts": 1685002583
            },
            {
                "name": "MyMacbook",
                "mac_addr": "4a:90:f0:42:1a:a2",
                "ip": "192.168.245.22",
                "tx_rate": 573,
                "rx_rate": 2401,
                "ssid": "SGold10",
                "rssi": -31,
                "snr": 64,
                "assoc_time": 33067,
                "channel": 48,
                "apMac": "20:6d:31:bb:00:00",
                "ts": 1685002583
            }
        ]
    })
});

module.exports = router;
