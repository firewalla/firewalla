
let net = require('net');
let util = require('util');
let fs = require('fs');
const log = require('../../net2/logger.js')(__filename);

const defaultOptions = {
  host: 'whois.iana.org',
  port: 43,
  raw: false
};

const MAX_RESPONSE_SIZE = 1024 * 1024;

async function lookup (query, options) {
  let tryIP = false;

    if (options) {
      options = Object.assign({}, defaultOptions, options);
    }
    
    let client = net.connect(options.port, options.host, function() {
        client.write(query + '\n', 'ascii'); 
    });

    let content = [];
    let contentSize = 0;
    let settled = false;
    let rejectPromise;

    client.on('data', function(data){
        if (settled) {
          return;
        }

        contentSize += data.length;
        if (contentSize > MAX_RESPONSE_SIZE) {
          const err = new Error(`WHOIS response exceeds maximum size of ${MAX_RESPONSE_SIZE} bytes`);
          settled = true;
          client.destroy();
          rejectPromise(err);
          return;
        }

        content.push(data);
    });

    client.on('error', (err) => {
      log.error("Failed to lookup whois:", err); // catch error to prevent node from crash

      if(err.code === 'ENOTFOUND' && options.ip) {
        tryIP = true;
      }
    });

    return new Promise((resolve, reject) => {
        rejectPromise = reject;

        client.on('close', function(err) {
            if (settled) {
              return;
            }
            settled = true;
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
