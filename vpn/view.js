/*    Copyright 2016-2019 Firewalla INC
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

var natUpnp = require('nat-upnp');

var client = natUpnp.createClient();

/*
client.portMapping({
  protocol: 'udp',
  public: 1194,
  private: 1194,
  ttl: 0
}, function(err) {
  // Will be called once finished 
});
*/

/*
client.portUnmapping({
  public:1194 
});
*/

setInterval(() => {
    client.getMappings(function (err, results) {
        console.log(results);
    });
}, 5000);

client.getMappings({
    local: true
}, function (err, results) {});

client.externalIp(function (err, ip) {
    console.log(ip);
});