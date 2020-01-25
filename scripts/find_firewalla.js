/*    Copyright 2019-2020 Firewalla INC
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

 // requirement: 
//    npm install bonjour
// node find_firewalla.js

'use strict'
let bonjour = require('bonjour')();

bonjour._server.mdns.on('warning', (err) => console.warn("Warning on mdns server", err))
bonjour._server.mdns.on('error', (err) => console.error("Error on mdns server", err))
bonjour.find({type: 'http'}, (service) => {
  // console.log(service);
  if(service.name.startsWith("eph:devhi:netbot") &&
      service.referer && service.referer.address
  ) {
    console.log("Found firewalla device: ", service.referer.address);
      console.log(service)
    setTimeout(() => process.exit(0), 3000);
  }
});
