/*    Copyright 2026 Firewalla Inc.
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

function getRaRouterLifetime(intf) {
  if (!intf || !intf.config || !intf.config.meta || intf.config.meta.type !== "wan")
    return null;

  const value = intf.state && intf.state.ra_router_lifetime;
  if (Number.isInteger(value) && value >= 0 && value <= 65535)
    return value;

  return null;
}

module.exports = getRaRouterLifetime;
