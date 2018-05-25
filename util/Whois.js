'use strict';

const util = require('util');
const log = require("../net2/logger.js")(__filename);
const {isIP, isFQDN} = require('validator');
const _whois = util.promisify(require('../lib/whois').lookup);
const camelCase = require("camel-case");
const psl = require('psl');

class Whois {

  constructor() {
    log.info("Whois Client Init");
    this.timeout = 5000;
    this.nomatchSignals = [
      'no match',
      'not found',
      'not exist',
      'no data found',
      'error:',
      'no entries found',
      'returned 0 objects',
    ];
  }

  _isValid(target) {
    return target && (isIP(target) || isFQDN(target));
  }

  _parseWhois(info) {
    if (!info) {
      return;
    }

    const lines = info.split('\n');
    let obj = lines.reduce((val, line) => {
      if (val.noMatch) {
        return val;
      }

      let noMatch = this.nomatchSignals
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
  
  async lookup(target, opts) {
    if (!this._isValid(target)) {
      log.warn("invalid target:", target, {});
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

    let whois;
    try {
      whois = await Promise.race([
        new Promise(resolve => setTimeout(resolve, this.timeout)),
        _whois(_target, {host: 'whois.iana.org', port: 43})
          .then(info => {
            let _info = info;
            if (!opts.raw) {
              try {
                _info = this._parseWhois(info);
              } catch (err) {
                log.error(`Unable to parse whois data: ${info}`, err);
                return;
              }
            }
            return _info;
          })
      ]);
    } catch (err) {
      log.error(`Unable to lookup whois information for target: ${_target}, original target is: ${target}`, err);
      return;
    }

    return whois;
  }
}

module.exports = new Whois();
