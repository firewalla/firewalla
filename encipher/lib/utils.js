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
var fs = require('fs');

var utils = class {
    getCpuId() {
        var cpuinfoString = !fs.existsSync('/proc/cpuinfo') ? '' : fs.readFileSync('/proc/cpuinfo') + '';
        var cpuinfo = cpuinfoString.split('\n').reduce(function (result, line) {
            line = line.replace(/\t/g, '')
            var parts = line.split(':')
            var key = parts[0].replace(/\s/g, '_')
            if (parts.length === 2) {
                result[key] = parts[1].trim().split(' ')
            }
            return result
        }, {})

        return cpuinfo.Serial[0].replace(/^[0]+/g, "");
    }
}

module.exports = new utils();
