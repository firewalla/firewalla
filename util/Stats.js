/*    Copyright 2019 Firewalla INC
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
var childProcess = require('child_process');

function sysmemory(args, cb) {
	childProcess.execFile('free', args, function (err, stdout) {
		if (err) {
			cb(err);
			return;
		}

        var memInfo = {};
		stdout.trim().split('\n').slice(1).map(function (el) {
			var cl = el.split(/\s+(?=[\d\/])/).map(function(i, idx) { return idx ? parseInt(i, 10) : i; });
			switch(cl[0]) {
				case "Mem:":
				    memInfo.mem = {
						total: cl[1],
						used: cl[2],
						free: cl[3],
						shared: cl[4],
						buffers: cl[5],
						cached: cl[6],
						usable: cl[3] + cl[5] + cl[6]
					};
				    break;
				case "-/+ buffers/cache:":
				    memInfo.buffer = memInfo.cache = {
						used: cl[1],
						free: cl[2]
					};
				    break;
				case "Swap:":
				    memInfo.swap = {
						total: cl[1],
						used: cl[2],
						free: cl[3]
					};
				    break;
			}
		});
		
		if (!memInfo.buffer) {
		    memInfo.buffer = memInfo.cache = {
		        used: memInfo.mem.total - memInfo.mem.usable,
		        free: memInfo.mem.usable
		    };
		}
		
		return cb(null, memInfo);
	});
}

module.exports = {
    sysmemory:sysmemory
};


