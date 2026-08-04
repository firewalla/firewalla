#!/bin/env node

/*    Copyright 2019-2025 Firewalla INC
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

'use strict'

let hash = require('../util/Hashes.js');
let util = require('util');
let blackholeIP = "0.0.0.0";

let domains = process.argv.slice(2)

domains.forEach((domain) => {
  if(!domain.endsWith("/")) {
    domain = domain + "/";
  }
  
  let hashedDomain = hash.getHashObject(domain).hash.toString('base64');
  let output = util.format("hash-address=/%s/%s", hashedDomain.replace(/\//g, '.'), blackholeIP);
  console.log(output);
});



