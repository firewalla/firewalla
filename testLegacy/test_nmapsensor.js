/*    Copyright 2016 - 2019 Firewalla INC 
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

let chai = require('chai');
let expect = chai.expect;

let NmapSensor = require('../sensor/NmapSensor');

let sampleJSON = require('../extension/nmap/scripts/example.output.json');

sampleJSON.nmaprun.host.forEach((h) => {
  let host = NmapSensor.parseNmapHostResult(h);
  if(host.ipv4Addr === "192.168.56.101")
    console.log(host);
});

setTimeout(() => {
  process.exit(0);
}, 3000);