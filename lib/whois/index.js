/*    Copyright 2018-2019 Firewalla INC
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

let net = require('net');
let util = require('util');
let fs = require('fs');
const log = require('../../net2/logger.js')(__filename);

const defaultOptions = {
  host: 'whois.iana.org',
  port: 43,
  raw: false
};

async function lookup (query, options) {
  let tryIP = false;

    if (options) {
      options = Object.assign({}, defaultOptions, options);
    }
    
    let client = net.connect(options.port, options.host, function() {
        client.write(query + '\n', 'ascii'); 
    });

    let content = [];

    client.on('data', function(data){
        content.push(data);
    });

    client.on('error', (err) => {
      log.error("Failed to lookup whois:", err); // catch error to prevent node from crash

      if(err.code === 'ENOTFOUND' && options.ip) {
        tryIP = true;
      }
    });

    return new Promise((resolve, reject) => {
        client.on('close', function(err) {
            if (err) {
              if(tryIP) {
                const optionsCopy = JSON.parse(JSON.stringify(options));
                optionsCopy.host = optionsCopy.ip;
                delete optionsCopy.ip;
                lookup(query, optionsCopy).then((result) => {
                  resolve(result);
                }).catch((err) => {
                  reject(err);
                });
              } else {
                reject(err);
              }
            } else {
                let parser = './parser/' + options.host + '.js';

                let bc = Buffer.concat(content);

                fs.exists(parser, function(exists) {
                    if (exists) {
                        resolve(options.raw ? bc.toString('ascii') : require(parser).parse(bc));
                    } else {
                        resolve(options.raw ? bc.toString('ascii') : {});
                    }
                });
            }
        })
    });
}

exports.lookup = lookup;

exports.options = {
    host: 'whois.iana.org',
    port: 43,
    raw: false
};
