/*    Copyright 2026 Firewalla Inc.
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
  const greedyMatchOrderedKeys = Object.keys(keywordTypeMap).sort((a, b) => b.length - a.length)
  for (const keyword of greedyMatchOrderedKeys) {
    if (nameLow.includes(keyword))
      return keywordTypeMap[keyword]
  }

  return null
}

// Given a host's macVendor (OUI lookup string), return the list of device types
// this vendor is known to produce — or null if the asset has no opinion.
// Each asset key is treated as a case-insensitive substring of macVendor, so
// a single short key (e.g. "TP-Link") covers all OUI registration variants
// ("TP-LINK TECHNOLOGIES CO.,LTD.", "TP-Link Corporation Limited",
// "TP-Link Systems Inc.", ...). First match wins
async function getMacVendorAllowedTypes(macVendor) {
  if (!macVendor) return null
  const map = await assetsManager.get('detect/common/macTypeConstraint.json')
  if (!map) return null
  const v = macVendor.toLowerCase()
  for (const key of Object.keys(map))
    if (v.includes(key.toLowerCase())) return map[key]
  return null
}

module.exports = {
  nameToType,
  getMacVendorAllowedTypes,
}
