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

// just get the type now
async function modelToType(identifier) {
  try {
    if (!identifier) return null
    const main = identifier.split(',')[0]
    let i = 0
    while (main[i] < '0' || main[i] > '9') {
      i ++
    }
    const modelPfxToType = await assetsManager.get('detect/apple/modelPfxToType.json')
    return modelPfxToType[main.substring(0, i)]
  } catch(err) {
    log.error('Error convering model', identifier, err)
    return null
  }
}

async function boardToModel(internalCode) {
  if (!internalCode) return null
  const boardToModel = await assetsManager.get('detect/apple/boardToModel.json')
  return boardToModel[internalCode.toLowerCase()]
}

module.exports = {
  modelToType,
  boardToModel,
}

