/*    Copyright 2023 Firewalla Inc.
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

const log = require('../../net2/logger.js')(__filename);
const assetsManager = require('../../util/AssetsManager.js')

async function nameToType(name) {
  if (!name) return null

  const nameLow = name.toLowerCase()
  const keywordTypeMap = await assetsManager.get('detect/common/keywordToType.json')
  const greedyMatchOrderedKeys = keywordTypeMap.sort((a, b) => b.length - a.length)
  for (const keyword of greedyMatchOrderedKeys) {
    if (nameLow.includes(keyword))
      return keywordTypeMap[keyword]
  }

  return null
}

module.exports = {
  nameToType,
}
