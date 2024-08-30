'use strict';

const util = require('util');
const log = require("../net2/logger.js")(__filename);
const {isIP, isFQDN} = require('validator');
const whoisClient = require('../lib/whois');
const camelCase = require("camel-case");
const psl = require('psl');

const nomatchSignals = [
  'no match',
  'not found',
  'not exist',
  'no data found',
  'error:',
  'no entries found',
  'returned 0 objects',
];

function _isValid(target) {
  return target && (isIP(target) || isFQDN(target));
}

function _parseWhois(info) {
  if (!info) {
    return {};
  }

  const lines = info.split('\n');
  let obj = lines.reduce((val, line) => {
    if (val.noMatch) {
      return val;
    }

    let noMatch = nomatchSignals
      .map(signal => line.toLowerCase().includes(signal))
      .reduce((val, cur) => val || cur, false);

    if (noMatch) {
      return {noMatch};
    }

    const index = line.indexOf(':');
    if (index !== -1) {
      let key = camelCase(line.substr(0, index));
      if (key.length > 15 || key.includes('http')) {
        return val;
      }

      let _val = line.substr(index + 1).trim();
      if (val[key]) {
        if (Array.isArray(val[key])) {
          val[key].push(_val);
        } else {
          val[key] = [val[key], _val];
        }
      } else {
        val[key] = _val;
      }
    }
    return val;
  }, {});

  if (obj.noMatch) {
    obj = {noMatch: true};
  }

  return obj;
}

class Whois {

  constructor() {
    log.info("Whois Client Init");
    this.timeout = 5000;
  }
  
  async lookup(target, opts) {
    if (!opts) {
      opts = {};
    }

    if (!_isValid(target)) {
      log.warn("invalid target:", target);
      return;
    }

    let _target;
    if (isIP(target)) {
      _target = target;
    } else if (isFQDN(target)) {
      let parsed = psl.parse(target);
      _target = parsed.domain || parsed.tld;
    }

    if (!_target) {
      return;
    }

    async function _whois(_target, opts) {
      let newOpts = Object.assign({}, opts, {raw: true});
      log.debug("target: ", target, ", opts:", opts, ", newOpts:", newOpts);

      let info = await whoisClient.lookup(_target, newOpts);
      let _info = info;
      log.debug("Whois info from '", opts.host, "':", info);

      try {
        _info = _parseWhois(info);
      } catch (err) {
        log.info(`Unable to parse whois data: ${info}`, err);
        return;
      }

      let refer = _info.refer;
      if (refer && isFQDN(refer)) {
        _info = await _whois(_target, Object.assign({}, opts, {host: refer}));
      }

      return _info;
    }

    let whois;
    try {
      whois = await Promise.race([
        new Promise(resolve => setTimeout(resolve, this.timeout)),
        _whois(_target, {host: 'whois.iana.org', ip: "192.0.32.59", port: 43})
      ]);
    } catch (err) {
      log.error(`Unable to lookup whois information for target: ${_target}, original target is: ${target}`, err);
      return;
    }

    return whois;
  }
}

module.exports = new Whois();
