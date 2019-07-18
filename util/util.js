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

const Promise = require('bluebird');

function extend(target) {
  var sources = [].slice.call(arguments, 1);
  sources.forEach(function (source) {
    for (var prop in source) {
      target[prop] = source[prop];
    }
  });
  return target;
}

function getPreferredName(hostObject) {
  if (hostObject==null) {
    return null
  }

  if(hostObject.name) {
    return hostObject.name // always use user customized name first
  }

  return getPreferredBName(hostObject);
}


function getPreferredBName(hostObject) {

  if (hostObject==null) {
    return null;
  }

  if(hostObject.spoofMeName) {
    return hostObject.spoofMeName
  }

  if(hostObject.cloudName) {
    return hostObject.cloudName
  }

  if(hostObject.dhcpName) {
    return hostObject.dhcpName
  }

  if(hostObject.bonjourName) {
    return hostObject.bonjourName
  }

  if(hostObject.bname) {
    return hostObject.bname
  }

  if (hostObject.pname) {
    return hostObject.pname
  }
  if (hostObject.hostname) {
    return hostObject.hostname
  }
  if (hostObject.macVendor != null) {
    let name = hostObject.macVendor
    return name
  }
  return hostObject.ipv4Addr
}

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t);
  });
}

module.exports = {
  extend:extend,
  getPreferredBName: getPreferredBName,
  getPreferredName: getPreferredName,
  delay: delay
}
