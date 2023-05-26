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

const getPreferredName = require('../../util/util.js').getPreferredName

const CloudWrapper = require('../lib/CloudWrapper');
const cloudWrapper = new CloudWrapper();

const util = require('util')
const jsonfile = require('jsonfile');
const jsReadFile = util.promisify(jsonfile.readFile)

let gid = null;

async function get_latency(mac) {
    const body = {
        "message": {
            "from": "iRocoX",
            "obj": {
                "mtype": "get",
                "id": "DA45C7BE-9029-4165-AD56-7860A9A3AE6B",
                "data": {
                    "value":
                        { 
                            "type": "host", 
                            "target": mac, 
                            "queries": { "latency": {} },
                            streaming: mac,
                        },
                    "item": "liveStats"
                },
                "type": "jsonmsg",
                "target": "0.0.0.0"
            },
            "appInfo": {
                "appID": "com.rottiesoft.circle",
                "version": "1.25",
                "platform": "ios"
            },
            "msg": "",
            "type": "jsondata",
            "compressMode": 1,
            "mtype": "msg"
        },
        "mtype": "msg"
    }

    const controller = await cloudWrapper.getNetBotController(gid);
    const response = await controller.msgHandlerAsync(gid, body, "app");

    return response && 
    response.data && 
    response.data.latency &&
    response.data.latency[0] &&
    response.data.latency[0].latency

}

/* GET home page. */
router.get('/json/stats.json', async (req, res, next) => {
    if (!gid)
        gid = (await jsReadFile("/home/pi/.firewalla/ui.conf")).gid;

    const keys = await rclient.keysAsync('assets:status:*');
    const devices = [];
    for (const key of keys) {
        try {
            const device_str = await rclient.getAsync(key);
            const device = JSON.parse(device_str);
            const mac = device.mac_addr.toUpperCase();
            const entry = await hostTool.getMACEntry(mac);
            const ip = entry.ipv4;
            const name = getPreferredName(entry);

            let apMac = device.apMac;
            if(apMac) {
                apMac = apMac.toUpperCase();
                const apEntry = await hostTool.getMACEntry(apMac);
                const name = getPreferredName(apEntry);
                device.apName = name;
            }

            device.ip = ip;
            device.name = name;
            device.latency = await get_latency(mac);
            devices.push(device);
        } catch(err) {
            log.error("Got error when process device: " + key + " " + err);
        }
    }
    res.json({
        "devices": devices
    });
});

module.exports = router;
