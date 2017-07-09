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
let log = require('../net2/logger.js')(__filename);

var bone = require("../lib/Bone.js");

let flowUtil = require("../net2/FlowUtil.js");

setTimeout(() => {
  let obj = {
    ou: "F4:0F:24:34",
    uuid: flowUtil.hashMac("f4:0f:24:34:73:64")
  };
  console.log(obj);
  bone.device("identify", obj, (err, data) => {
    console.log(err, data);
  });
}, 10000);
