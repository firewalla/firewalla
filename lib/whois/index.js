
let net = require('net');
let util = require('util');
let fs = require('fs');

async function lookup (query, options) {
    if (options) {
        options = util._extend(this.options, options);
    }
    
    let client = net.connect(options.port, options.host, function() {
        client.write(query + '\n', 'ascii'); 
    });

    let content = [];

    client.on('data', function(data){
        content.push(data);
    });

    return new Promise((resolve, reject) => {
        client.on('close', function(err) {
            if (err) {
                reject(err);
            } else {
                let parser = './parser/' + options.host + '.js';

                let bc = Buffer.concat(content);

                fs.exists(parser, function(exists) {
                    if (exists) {
                        resolve(options.raw ? bc : require(parser).parse(bc));
                    } else {
                        resolve(options.raw ? bc : {});
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
