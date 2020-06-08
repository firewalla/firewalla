/*    Copyright 2019 Firewalla INC
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
const cp = require('child_process');
const util = require('util');
const execAsync = util.promisify(cp.exec);
const f = require('../../net2/Firewalla.js');
const log = require('../../net2/logger.js')(__filename, 'info');
const rclient = require('../../util/redis_manager.js').getRedisClient();
const speedtestCli = `${f.getFirewallaHome()}/extension/speedtest/speedtest-cli`;


async function speedtest() {
    try {
        const cmd = `python ${speedtestCli} --json`
        let { stdout } = await execAsync(cmd);
        if (stdout) {
            rclient.zadd("network:speed:test", Math.floor(new Date() / 1000), stdout);
            stdout = JSON.parse(stdout)
            return stdout
        }
    } catch (err) {
        log.error('speedtest error', err);
        return {};
    }
}

module.exports = speedtest;
