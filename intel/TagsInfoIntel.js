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
const Constants = require('../net2/Constants.js');

class TagsInfoIntel extends Intel {
    async enrichAlarm(alarm) {
      for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
        const config = Constants.TAG_TYPE_MAP[type];
        const idKey = config.alarmIdKey;
        const nameKey = config.alarmNameKey;
        if (_.has(alarm, idKey)) {
          let names = [];
          for (let index = 0; index < alarm[idKey].length; index++) {
            const tagUid = alarm[idKey][index];
            const tagInfo = tagManager.getTagByUid(tagUid);
            if (tagInfo) {
              names.push({ uid: tagUid, name: tagInfo.getTagName() });
            }
          }

          alarm[nameKey] = names;
        }
      }

      return alarm;
    }
}

module.exports = TagsInfoIntel
