
var rgProp = /^([^:]+):\s*(.*)$/;

exports.parse = function(data) {
    
    var data = data.toString('ascii');

    
    var chunks = data.split('\r\n\r\n');
    
    if (chunks.length != 3) return;
    
    var part = chunks[1];
    
    if (!part || (part == '\n')) return;
    
    var po = {};
    var lines = part.split('\r\n');
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
                if (value) {
                    po[prop].push(value);
                }
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
    
    return po;
};
