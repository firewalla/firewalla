
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
  let timedOut = false;
  let timeoutTimer = null;

  if (options) {
    options = Object.assign({}, defaultOptions, options);
  } else {
    options = Object.assign({}, defaultOptions);
  }

  let client = net.connect(options.port, options.host, function() {
    client.write(query + '\n', 'ascii');
  });

  const content = [];

  if (Number.isFinite(options.timeout) && options.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      client.destroy(new Error('WHOIS lookup timed out'));
    }, options.timeout);
  }

  client.on('data', function(data){
    content.push(data);
  });

  client.on('error', (err) => {
    log.error("Failed to lookup whois:", err);

    if (!timedOut && err.code === 'ENOTFOUND' && options.ip) {
      tryIP = true;
    }
  });

  return new Promise((resolve, reject) => {
    client.on('close', function(err) {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }

      if (timedOut) {
        reject(new Error('WHOIS lookup timed out'));
        return;
      }

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
    });
  });
}

exports.lookup = lookup;

exports.options = {
    host: 'whois.iana.org',
    port: 43,
    raw: false
};
