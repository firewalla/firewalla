
var rgProp = /^([\w-]+):\s*(.+)$/;

exports.parse = function(data) {
    
    var data = data.toString('ascii');
    var parts = [];
    
    data.split('\n\n').forEach(function(part) {
        if (!part) return;
        
        var po = {};
        var lines = part.split('\n');
        var prop, value;
        
        lines.forEach(function(line) {
            if (line[0] == '%') return;
            
            var pair = rgProp.exec(line);
            if (pair) {
                prop = pair[1];
                value = pair[2];
                
                switch (prop) {
                    case 'nserver':
                        pair = value.split(/\s+/g);
                        if (pair) {
                            value = {hostname: pair[0]};
                            if (pair[1]) {
                                value.ipv4 = pair[1];
                            }
                            if (pair[2]) {
                                value.ipv6 = pair[2];
                            }
                        }
                        break;
                }
                
                if ( typeof po[prop] != 'undefined') {
                    if (!(po[prop] instanceof Array)) {
                        po[prop] = [po[prop]];
                    } 
                    
                    po[prop].push(value);
                } else {
                    po[prop] = value;
                }
                
            } else if (prop && po[prop]) {
                if (po[prop] instanceof Array) {
                    po[prop].push(line);
                } else {
                    po[prop] += '\n' + line;
                }
            }
        });

        if (prop) {
            parts.push(po);
        }

    });
    
    var ret = {
        contact: []
    };
    
    parts.forEach(function(part) {
        if (part.contact) {
            return ret.contact.push(part);
        }
        
        var keys = Object.keys(part);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            
            if (ret[key]) {
                if (!(ret[key] instanceof Array)) {
                    ret[key] = [ret[key]];
                }
                
                ret[key].push(part[key]);
            } else {
                ret[key] = part[key];
            }
        }
    });
    
    return ret;
};
