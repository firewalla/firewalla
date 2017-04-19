/*    Copyright 2016 Rottiesoft LLC 
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

let bone = require("../../lib/Bone.js");

let log = require("../../net2/logger.js")(__filename, 'info');

let SysManager = require('../../net2/SysManager.js');
let sysManager = new SysManager('info');

function isInitialized(req, res, next) {
  if (bone.cloudready()==true &&
      // this is to ensure sysManager is already initliazed when called in API code
      sysManager.isConfigInitialized()) {
    log.info("Firewalla initliazed");
    next();
  } else {
    res.status(503);
    res.json({error: 'Initializing Firewalla Device, please try later'});
  }
}

module.exports = {
  isInitialized: isInitialized
}
