/*    Copyright 2016-2024 Firewalla Inc.
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
const moment = require('moment');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();

const validDomainRegex = /^[a-zA-Z0-9-_.]+$/
const validVersionRegex = /^[0-9.]+/

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
  if (!hostObject) {
    return null
  }

  if (hostObject.name) {
    return hostObject.name // always use user customized name first
  }

  return getPreferredBName(hostObject);
}

// priority list of names on App (legacy) goes:
// hostname, name, bname, bonjourName, dhcpName
//
// we should be avoiding setting anything used here as 'Unknown' (for easier checking)
// except on serializing to JSON before returning to App

function getPreferredBName(hostObject) {

  if (!hostObject) {
    return null;
  }

  if (hostObject.cloudName) {
    return hostObject.cloudName
  }

  let detectName
  let modelName
  if (hostObject.detect) {
    let detect = hostObject.detect
    if (_.isString(detect)) try {
      detect = JSON.parse(detect)
    } catch(err) { }

    detectName = _.get(detect, 'cloud.name') || _.get(detect, 'bonjour.name')
    if (detectName)
      return detectName
    else
      detectName = detect.name

    modelName = detect.model
  }

  const name = hostObject.dhcpName
    || hostObject['dnsmasq.dhcp.leaseName']
    || hostObject.bonjourName
    || hostObject.sambaName
    // hostname doesn't seem to be assigned anywhere, on App, this actually has the highest priority
    || hostObject.hostname
    // below 2 mostly from user-agent now
    || detectName
    || modelName
    || hostObject.modelName // from SSDP

  if (name) return name

  if (hostObject.macVendor != null && hostObject.macVendor !== 'Unknown') {
    return hostObject.macVendor
  }

  // all of the clients we have show IP together with name, this doesn't make sense anymore
  // if (hostObject.ipv4Addr)
  //   return hostObject.ipv4Addr

  // if (hostObject.ipv6Addr) {
  //   let v6Addrs = hostObject.ipv6Addr || [];
  //   if (_.isString(v6Addrs)) {
  //     try {
  //       v6Addrs = JSON.parse(v6Addrs);
  //     } catch (err) { }
  //   }
  //   return v6Addrs[0]
  // }

  if (hostObject.wlanVendor && hostObject.wlanVendor.length > 0) {
    return hostObject.wlanVendor[0]
  }

  return undefined;
}

function delay(t) {
  return new Promise(function (resolve) {
    setTimeout(resolve, t);
  });
}

const keysToRedact = new Set(["password", "passwd", "psk", "key", "psks"]);
function redactLog(obj, redactRequired = false) {
  if (!obj)
    return obj;
  // obj should be either object or array
  const objCopy = _.isArray(obj) ? [] : Object.create(obj);
  try {
    for (const key of Object.keys(obj)) {
      if (_.isObject(obj[key]) || _.isArray(obj[key]))
        objCopy[key] = redactLog(obj[key], redactRequired || keysToRedact.has(key));
      else {
        if (redactRequired || keysToRedact.has(key))
          objCopy[key] = "*** redacted ***";
        else
          objCopy[key] = obj[key];
      }
    }
  } catch (err) {}
  return objCopy;
}

// pass in function arguments object and returns string with whitespaces
function argumentsToString(v) {
  // convert arguments object to real array
  var args = Array.prototype.slice.call(v);
  for (var k in args) {
    if (typeof args[k] === "object") {
      // args[k] = JSON.stringify(args[k]);
      if (_.isArray(args[k]) || _.isObject(args[k]))
        args[k] = redactLog(args[k]);
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
    return (await fsp.stat(path)).isFile()
  } catch(err) {
    if (err.code !== 'ENOENT') throw err;
    return false;
  }
}

async function fileTouch(path) {
  try {
    const time = Date.now() / 1000
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
    validChunks.push(chunk.filter((ele, i) => results[i] && !(results[i] instanceof Error)))
  }
  return _.flatten(validChunks)
}

function difference(obj1, obj2) {
  return _.uniq(_diff(obj1, obj2).concat(_diff(obj2, obj1)));
}

function _diff(obj1, obj2) {
  if (!obj1 || !_.isObject(obj1)) {
    return [];
  }
  if (!obj2 || !_.isObject(obj2)) {
    return Object.keys(obj1);
  }
  return _.reduce(obj1, function(result, value, key) {
    return _.isEqual(value, obj2[key]) ?
        result : result.concat(key);
  }, []);
}

function _extractVersion(ver) {
  let v = ver.match(validVersionRegex);
  if (!v) return "";
  return v[0];
}

// check if ver1 < ver2
function versionCompare(ver1, ver2) {
  const v1 = _extractVersion(ver1).split('.');
  const v2 = _extractVersion(ver2).split('.');

  for (let i = 0; i < v1.length && i < v2.length; i++){
    if (parseInt(v1[i]) > parseInt(v2[i])) return false;
    if (parseInt(v1[i]) < parseInt(v2[i])) return true;
  }
  if (v1.length >= v2.length) return false;
  return true;
}

// wait for condition till timeout
function waitFor(condition, timeout=3000) {
  const deadline = Date.now() + timeout;
  const poll = (resolve, reject) => {
    if(condition()) resolve();
    else if (Date.now() >= deadline) reject(`exceeded timeout of ${timeout} ms`); // timeout reject
    else setTimeout( _ => poll(resolve, reject), 800);
  }
  return new Promise(poll);
}

/* wrap a promise with timeout
 * reject with error if timeout
 * example:
 *   withTimeout(exampleAsyncFunction(), 2000).then(result => {
 *     console.log(result);
 *   }).catch(err => {
 *     console.error(err);
 *   });
 */
async function withTimeout(promise, timeout) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Operation timed out')), timeout)
    ),
  ]);
}

module.exports = {
  extend,
  getPreferredBName,
  getPreferredName,
  delay,
  difference,
  versionCompare,
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
  waitFor,
  withTimeout,
};
