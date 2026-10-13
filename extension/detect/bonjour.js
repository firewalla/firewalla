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

const assetsManager = require('../../util/AssetsManager.js')

const ASSET_PATH = 'detect/common/bonjour.json'

async function getConfig() {
  return await assetsManager.get(ASSET_PATH) || null
}

async function getPriority(serviceType) {
  if (!serviceType) return 0
  const config = await getConfig()
  const priorities = config && config.priorities || {}
  return priorities[serviceType] || 0
}

async function getList(listName) {
  const config = await getConfig()
  return config && Array.isArray(config[listName]) ? config[listName] : null
}

module.exports = {
  getPriority,
  getList,
}
