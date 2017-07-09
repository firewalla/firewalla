/*    Copyright 2016 Firewalla LLC 
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

let _ = require('underscore');
let chai = require('chai');
let expect = chai.expect;

let HostTool = require('../net2/HostTool.js');
let hostTool = new HostTool();

let object = {
  "a" : undefined,
  "b" : 1
}

hostTool.cleanupData(object);

expect(Object.keys(object).length).to.equal(1)
expect(object.b).to.equal(1);

setTimeout(() => {
  process.exit(0);
}, 3000);
