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

const _ = require('lodash');
const log = require('../net2/logger.js')(__filename);

const Intel = require('./Intel.js');
const tagManager = require('../net2/TagManager.js');

class TagsInfoIntel extends Intel {
    async enrichAlarm(alarm) {
        if (_.has(alarm, 'p.tag.ids')) {
            let names = [];
            for (let index = 0; index < alarm['p.tag.ids'].length; index++) {
                const tagUid = alarm['p.tag.ids'][index];
                const tagInfo = tagManager.getTagByUid(tagUid);
                if (tagInfo) {
                    names.push({ uid: tagUid, name: tagInfo.getTagName() });
                }
            }

            Object.assign(alarm, {
                'p.tag.names': names
            });
        }

        return alarm;
    }
}

module.exports = IntfInfoIntel
