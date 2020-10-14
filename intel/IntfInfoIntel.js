/*    Copyright 2019 Firewalla LLC
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

const _ = require('lodash');
const log = require('../net2/logger.js')(__filename);

const Intel = require('./Intel.js');
const sysManager = require('../net2/SysManager.js');

class IntfInfoIntel extends Intel {
    async enrichAlarm(alarm) {
        if (_.has(alarm, 'p.intf.id')) {
            // add intf info
            const intfInfo = sysManager.getInterfaceViaUUID(alarm['p.intf.id']);
            if (intfInfo) {
                Object.assign(alarm, {
                    'p.intf.subnet': intfInfo.subnet,
                    'p.intf.subnet6': intfInfo.ip6_subnets,
                    'p.intf.name': intfInfo.name
                });
            } else {
                log.error(`Unable to find nif uuid, ${alarm['p.intf.id']}`);
            }
        }

        return alarm;
    }

}

module.exports = IntfInfoIntel
