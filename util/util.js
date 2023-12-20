/*    Copyright 2016-2023 Firewalla Inc.
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

const fsp = require('fs').promises

const _ = require('lodash');
const stream = require('stream');
const moment = require('moment')

const validDomainRegex = /^[a-zA-Z0-9-_.]+$/

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

  if (_.get(hostObject, 'detect.bonjour.name')) {
    return hostObject.detect.bonjour.name
  }


  if (hostObject.dhcpName) {
    return hostObject.dhcpName
  }

  if (hostObject['dnsmasq.dhcp.leaseName']) {
    return hostObject['dnsmasq.dhcp.leaseName']
  }

  if (hostObject.bonjourName) {
    return hostObject.bonjourName
  }

  if (hostObject.bname) {
    return hostObject.bname
  }

  /* predict name is inaccurate, not suitable to use it at the moment
  if (hostObject.pname) {
    return hostObject.pname
  }
  */
  if (hostObject.hostname) {
    return hostObject.hostname
  }
  if (hostObject.macVendor != null) {
    let name = hostObject.macVendor
    return name
  }

  if (hostObject.ipv4Addr)
    return hostObject.ipv4Addr

  if (hostObject.ipv6Addr) {
    let v6Addrs = hostObject.ipv6Addr || [];
    if (_.isString(v6Addrs)) {
      try {
        v6Addrs = JSON.parse(v6Addrs);
      } catch (err) { }
    }
    return v6Addrs[0]
  }

  return undefined;
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
  const h1Sections = h1.toLowerCase().split('.').reverse();
  const h2Sections = h2.toLowerCase().split('.').reverse();
  // compare at most three sections from root
  const limit = Math.min(h1Sections.length - 1, h2Sections.length - 1, 2);
  for (let i = 0; i <= limit; i++) {
    if (h1Sections[i] !== h2Sections[i])
      return false;
  }
  return true;
}

function isSameOrSubDomain(a, b) {
  if (!_.isString(a) || !_.isString(b)) return false
  const dnA = a.toLowerCase().split('.').reverse().filter(Boolean)
  const dnB = b.toLowerCase().split('.').reverse().filter(Boolean)

  if (dnA.length > dnB.length) return false

  for (const i in dnA) {
    if (dnA[i] != dnB[i]) return false
  }

  return true
}

function formulateHostname(domain, stripWildcardPrefix = true) {
  if (!domain || !_.isString(domain))
    return null;
  if (domain.startsWith("*.") && stripWildcardPrefix)
    domain = domain.substring(2);
  domain = domain.substring(domain.indexOf(':') + 1);
  domain = domain.replace(/\/+/g, '/');
  domain = domain.replace(/^\//, '');
  domain = domain.substring(0, domain.indexOf('/') > 0 ? domain.indexOf('/') : domain.length);
  return domain;
}

function isDomainValid(domain) {
  if (!domain || !_.isString(domain))
    return false;
  return validDomainRegex.test(domain);
}

function generateStrictDateTs(ts) {
  const now = ts ? new Date(ts) : new Date();
  const offset = now.getTimezoneOffset(); // in mins
  const timeWithTimezoneOffset = now - offset * 60 * 1000;
  const beginOfDate = Math.floor(timeWithTimezoneOffset / 1000 / 3600 / 24) * 3600 * 24 * 1000;
  const beginTs = beginOfDate + offset * 60 * 1000;
  const endTs = beginTs + 24 * 60 * 60 * 1000;
  return {
    beginTs, endTs
  }
}

function isHashDomain(domain) {
  if (!domain || !_.isString(domain))
    return false;
  return domain.endsWith("=") && domain.length == 44
}

class LineSplitter extends stream.Transform {
  constructor() {
    super({ writableObjectMode: true });
    this.remaining = "";
  }

  _transform(chunk, encoding, done) {
    let data = chunk.toString();
    if (this.remaining) {
      data = this.remaining + data;
    }
    let lines = data.split("\n");
    this.remaining = lines[lines.length - 1];

    for (let i = 0; i < lines.length - 1; i++) {
      this.push(lines[i]);
    }
    done();
  }

  _flush(done) {
    if (this.remaining) {
      this.push(this.remaining);
    }

    this.remaining = "";
    done();
  }
}

function compactTime(ts) {
  return moment(ts * 1000).local().format('MMMDD HH:mm') + ' (' + ts + ')'
}

async function fileExist(path) {
  try {
    await fsp.stat(path)
  } catch(err) {
    if (err.code !== 'ENOENT') throw err;
    return false;
  }
  return true
}

async function fileTouch(path) {
  try {
    const time = Date.now()
    await fsp.utimes(path, time, time)
  } catch(err) {
    if (err.code !== 'ENOENT') throw err;
    const fh = await fsp.open(path, 'a');
    await fh.close();
  }
}

async function fileRemove(path) {
  try {
    await fsp.unlink(path);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function batchKeyExists(keys, batchSize) {
  const rclient = require('./redis_manager.js').getRedisClient()
  const validChunks = []
  for (const chunk of _.chunk(keys, batchSize)) {
    const batch = rclient.batch()
    chunk.forEach(key => batch.exists(key))
    const results = await batch.execAsync()
    validChunks.push(chunk.filter((ele, i) => results[i] && !results[i] instanceof Error))
  }
  return _.flatten(validChunks)
}

module.exports = {
  extend,
  getPreferredBName,
  getPreferredName,
  delay,
  argumentsToString,
  isSimilarHost,
  isSameOrSubDomain,
  formulateHostname,
  isDomainValid,
  generateStrictDateTs,
  isHashDomain,
  LineSplitter,
  compactTime,
  fileExist,
  fileTouch,
  fileRemove,
  batchKeyExists,
};
