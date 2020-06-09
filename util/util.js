/*    Copyright 2016-2020 Firewalla Inc.
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
  if (hostObject == null) {
    return null
  }

  if (hostObject.name) {
    return hostObject.name // always use user customized name first
  }

  return getPreferredBName(hostObject);
}


function getPreferredBName(hostObject) {

  if (hostObject == null) {
    return null;
  }

  if (hostObject.cloudName) {
    return hostObject.cloudName
  }

  if (hostObject.spoofMeName) {
    return hostObject.spoofMeName
  }

  if (hostObject.dhcpName) {
    return hostObject.dhcpName
  }

  if (hostObject.bonjourName) {
    return hostObject.bonjourName
  }

  if (hostObject.bname) {
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
  return new Promise(function (resolve) {
    setTimeout(resolve, t);
  });
}

// pass in function arguments object and returns string with whitespaces
function argumentsToString(v) {
  // convert arguments object to real array
  var args = Array.prototype.slice.call(v);
  for (var k in args) {
    if (typeof args[k] === "object") {
      // args[k] = JSON.stringify(args[k]);
      args[k] = require('util').inspect(args[k], false, null, true);
    }
  }
  var str = args.join(" ");
  return str;
}

function isSimilarHost(h1, h2) {
  if (!h1 || !h2)
    return false;
  const h1Sections = h1.split('.').reverse();
  const h2Sections = h2.split('.').reverse();
  // compare at most last three sections
  const limit = Math.min(h1Sections.length - 1, h2Sections.length - 1, 2);
  for (let i = 0; i <= limit; i++) {
    if (h1Sections[i] !== h2Sections[i])
      return false;
  }
  return true;
}

module.exports = {
  extend,
  getPreferredBName,
  getPreferredName,
  delay,
  argumentsToString,
  isSimilarHost
}
