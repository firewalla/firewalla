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

const modelTypeMap = {
  AppleTV:        'tv',
  AirPods:        'wearable',
  AirPodsPro:     'wearable',
  AirPodsMax:     'wearable',
  Watch:          'wearable',
  AudioAccessory: 'smart speaker',
  iPhone:         'phone',
  iPad:           'tablet',
  iPod:           'portable media player',
  iMac:           'desktop',
  Mac:            'desktop',
  MacPro:         'desktop',
  Macmini:        'desktop',
  MacBook:        'desktop',
  MacBookAir:     'desktop',
  MacBookPro:     'desktop',
}

// just get the type now
function modelToType(identifier) {
  try {
    const main = identifier.split(',')[0]
    let i = 0
    while (main[i] < '0' || main[i] > '9') {
      i ++
    }
    return modelTypeMap[main.substring(0, i)]
  } catch(err) {
    log.error('Error convering model', identifier, err)
    return null
  }
}

module.exports = {
  modelToType,
}

