
var net = require('net');
var util = require('util');
var fs = require('fs');

function lookup (query, options, callback) {

    if (typeof options == 'function') {
        callback = options;
        options = this.options;
    } else {
        options = util._extend(this.options, options);
    }

    
    var client = net.connect(options.port, options.host, function() {
        client.write(query + '\n', 'ascii'); 
    });

    var content = [];

    client.on('data', function(data){
        content.push(data);
    });

    client.on('close', function(err) {
        if (err) {
            callback(err);
        } else {
            var parser = './parser/' + options.host + '.js';
            
            var bc = Buffer.concat(content);
            
            fs.exists(parser, function(exists) {
                if (exists) {
                    callback(null, require(parser).parse(bc), bc);
                    
                } else {
                    callback(null, {}, bc);
                }
            });
            
            
        }
    });
};

exports.lookup = lookup;

exports.options = {
    host: 'whois.iana.org',
    port: 43
};
