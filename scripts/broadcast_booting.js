/*    Copyright 2016 Firewalla LLC / Firewalla LLC
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

const bonjour = require('bonjour')()
 
// advertise an HTTP server on port 3000 
bonjour.publish({ name: 'Firewalla Booting', type: 'http', port: 18833 })
 
setTimeout(() => {
  bonjour.unpublishAll((err) => {
    process.exit(0)
  })
}, 5 * 60 * 1000)