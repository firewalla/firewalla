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
var cpuid = null;


var utils = class {
    getCpuId() {
       if (cpuid == null)  {
           cpuid = this._getCpuId();
       }
       return cpuid;
    }
    _getCpuId() {
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

        if(cpuinfo.Serial && cpuinfo.Serial[0]) {
            return cpuinfo.Serial[0].replace(/^[0]+/g, "");
        } else {
          // if inside docker, use container id
          if (fs.existsSync("/.dockerenv")) {
            return require('child_process').execSync("basename \"$(head /proc/1/cgroup)\" | cut -c 1-12").toString().replace(/\n$/, '')
          } else {
            // no serial key from cpuinfo, use Linux Kernel uuid instead (WORKAROUND)
            return require('child_process').execSync("dmesg | grep UUID | grep 'Kernel' | sed 's/.*UUID=//g' | sed 's/\ ro\ quiet.*//g'").toString().replace(/\n$/, '');
          }
        }
    }
}

module.exports = new utils();
