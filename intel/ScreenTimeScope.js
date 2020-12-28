/*    Copyright 2020 Firewalla Inc
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

const Intel = require('./Intel.js');
const tagManager = require('../net2/TagManager.js');
const sysManager = require('../net2/SysManager.js');
const getPreferredName = require('../util/util.js').getPreferredName
const INTF_PREFIX = "intf:";
const TAG_PREFIX = "tag:";
const MAC_PREFIX = "mac:"
const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool();
class ScreenTimeScope extends Intel {
    async enrichAlarm(alarm) {
        if (alarm.type == "ALARM_SCREEN_TIME") {
            const names = [];
            if (alarm['p.scope'] && alarm['p.scope'].length > 0) {
                for (const ele of alarm['p.scope']) {
                    if (ele.includes(MAC_PREFIX)) {
                        const mac = ele.split(MAC_PREFIX)[1];
                        const hostInfo = await hostTool.getMACEntry(mac);
                        hostInfo && names.push(getPreferredName(hostInfo));
                    } else if (ele.includes(TAG_PREFIX)) {
                        const tagUid = ele.split(TAG_PREFIX)[1];
                        const tagInfo = tagManager.getTagByUid(tagUid);
                        tagInfo && names.push(tagInfo.getTagName());
                    } else if (ele.includes(INTF_PREFIX)) {
                        const uuid = ele.split(INTF_PREFIX)[1];
                        const intfInfo = sysManager.getInterfaceViaUUID(uuid);
                        intfInfo && names.push(intfInfo.name);
                    }
                }
            } else {
                names.push('System')
            }
            const msg = `${names.join(',')} has reached the time limit on ${alarm['p.target'] || 'Internet'}`;
            Object.assign(alarm, {
                'p.scope.names': names,
                'p.message': msg // debug purpose
            });
        }
        return alarm;
    }
}

module.exports = ScreenTimeScope
