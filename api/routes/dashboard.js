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
const rclient = require('../../util/redis_manager.js').getRedisClient();
const rclient1 = require('../../util/redis_manager.js').getRedisClientWithDB1();
const HostTool = require('../../net2/HostTool');
const hostTool = new HostTool();
const LRU = require('lru-cache');
const latencyCache = new LRU({maxAge: 5 * 1000 }); // cache for 5 seconds

const getPreferredName = require('../../util/util.js').getPreferredName

const CloudWrapper = require('../lib/CloudWrapper');
const cloudWrapper = new CloudWrapper();

const util = require('util')
const jsonfile = require('jsonfile');
const jsReadFile = util.promisify(jsonfile.readFile)

const FireRouter = require('../../net2/FireRouter.js');

let gid = null;

async function get_latency(mac) {
    const cache = latencyCache.get(mac);
    if (cache) {
        return cache;
    }

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
                    "item": "liveStats",
                    "ignoreRate": true,
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

    const result = response && 
    response.data && 
    response.data.latency &&
    response.data.latency[0] &&
    response.data.latency[0].latency;

    if(result) {
        latencyCache.set(mac, result);
    }

    return result;

}

let vips = null;

router.get('/json/vip_stats.json', async (req, res, next) => {
    if (!vips) {
        vips = await rclient.keysAsync('perf:ping:*').map(key => key.replace('perf:ping:', ''));
    }

    const result = {};

    for (const vip of vips) {
        let name = vip;

        try {
            const entry = await hostTool.getMacEntryByIP(vip);
            name = getPreferredName(entry);
        } catch(e) {
            // do nothing
        }

        const metrics = await rclient.zrangeAsync('perf:ping:' + vip, -720, -1);
        const data = metrics.map(metric => {
            const items = metric.split(",");
            const time = items[0];
            const value = items[1];
            return [time, value];
        });
        result[vip] = {
            name: name,
            stats: data
        }

    }

    res.json(result);
});

router.get('/json/stats.json', async (req, res, next) => {
    if (!gid)
        gid = (await jsReadFile("/home/pi/.firewalla/ui.conf")).gid;

    const devices = [];
    const staStatus = await FireRouter.getSTAStatus().catch((err) => {
      log.error(`Failed to get sta status from firerouter`, err.message);
      return null;
    });
    if (staStatus) {
      for (const mac of Object.keys(staStatus)) {
        try {
          const device = staStatus[mac];
          device.mac_addr = mac;
          const entry = await hostTool.getMACEntry(mac);
          if (entry) {
            const ip = entry.ipv4;
            const name = getPreferredName(entry);
            device.ip = ip;
            device.name = name;
          }
          device.latency = await get_latency(mac);

          let apMac = device.bssid;
          if (apMac) {
            apMac = apMac.toUpperCase();
            const apEntry = await hostTool.getMACEntry(apMac);
            const name = apEntry && getPreferredName(apEntry);
            device.apName = name;
          }
          devices.push(device);
        } catch (err) {
          log.error("Got error when process device: " + mac, err);
        }
      }
    }
    res.json({
        "devices": devices
    });
});

module.exports = router;
