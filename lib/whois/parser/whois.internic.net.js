
var rgProp = /^\s+([^:]+):\s*(.+)$/

exports.parse = function(data) {
    
    var data = data.toString('ascii');
    var parts = [];
    
    data.split('\n\n').forEach(function(part) {
        if (!part) return;
        
        var po = {};
        var lines = part.split('\n');
        var prop, value;
        
        lines.forEach(function(line) {
            
            var pair = rgProp.exec(line);
            if (pair) {
                prop = pair[1];
                value = pair[2];

                if (typeof po[prop] != 'undefined') {
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
    
    
    return parts;
};

