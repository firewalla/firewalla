
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
  let timedOut = false;
  let timeoutTimer = null;

  options = Object.assign({}, defaultOptions, options || {});

  let client = net.connect(options.port, options.host, function() {
    client.write(query + '\n', 'ascii');
  });

  const content = [];

  return new Promise((resolve, reject) => {
    let contentSize = 0;
    let settled = false;

    const clearTimeoutTimer = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    const rejectAndClose = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeoutTimer();
      client.destroy();
      reject(err);
    };

    client.on('data', function(data){
      if (settled) {
        return;
      }

      contentSize += data.length;
      if (contentSize > MAX_RESPONSE_SIZE) {
        rejectAndClose(new Error('WHOIS response exceeds maximum size of ' + MAX_RESPONSE_SIZE + ' bytes'));
        return;
      }

      content.push(data);
    });

    client.on('error', (err) => {
      log.error("Failed to lookup whois:", err);

      if (!timedOut && err.code === 'ENOTFOUND' && options.ip) {
        tryIP = true;
      }
    });

    client.on('close', function(err) {
      if (settled) {
        return;
      }

      clearTimeoutTimer();

      if (err) {
        if (tryIP) {
          const optionsCopy = JSON.parse(JSON.stringify(options));
          optionsCopy.host = optionsCopy.ip;
          delete optionsCopy.ip;
          lookup(query, optionsCopy).then((result) => {
            settled = true;
            resolve(result);
          }).catch((err) => {
            settled = true;
            reject(err);
          });
        } else {
          settled = true;
          reject(err);
        }
        return;
      }

      settled = true;
      let parser = './parser/' + options.host + '.js';

      let bc = Buffer.concat(content);

      fs.exists(parser, function(exists) {
        if (exists) {
          resolve(options.raw ? bc.toString('ascii') : require(parser).parse(bc));
        } else {
          resolve(options.raw ? bc.toString('ascii') : {});
        }
      });
    });

    const timeout = Number.isFinite(options.deadline)
      ? options.deadline - Date.now()
      : options.timeout;

    if (Number.isFinite(timeout) && timeout > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        rejectAndClose(new Error('WHOIS lookup timed out'));
      }, timeout);
    } else if (Number.isFinite(options.deadline)) {
      rejectAndClose(new Error('WHOIS lookup timed out'));
    }
  });
}

exports.lookup = lookup;

exports.options = {
    host: 'whois.iana.org',
    port: 43,
    raw: false
};