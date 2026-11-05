/*    Copyright 2020 Firewalla Inc.
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

let log = require('./logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('./Firewalla.js');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const pl = require('../platform/PlatformLoader.js');
const Constants = require('./Constants.js');
const platform = pl.getPlatform();
const profilesKey = 'platform:profile';
const activeProfileKey = 'platform:profile:active';
const profileUserDir = `${f.getRuntimeInfoFolder()}/profile`
let instance = null;
class CpuProfile {
    constructor() {
        if (!instance) {
            instance = this;
        }
        return instance;
    }
    async applyProfile(name) {
        // name becomes the platform:profile:active redis value, which apply_profile.sh uses as a
        // path, and is a path component of the profile file written below
        if (typeof name !== 'string' || !Constants.REGEX_FILENAME.test(name)) {
            throw new Error(`Invalid profile name: ${name}`);
        }
        await rclient.setAsync(activeProfileKey, name);
        const content = await rclient.hgetAsync(profilesKey, name);
        await fs.writeFileAsync(`${profileUserDir}/${name}`, content);
        await platform.applyProfile();
    }
    async addProfiles(profiles) {
        for (const profile of profiles) {
            const { name, content } = profile.name;
            await rclient.hsetAsync(profilesKey, name, content);
        }
    }
}

module.exports = new CpuProfile();