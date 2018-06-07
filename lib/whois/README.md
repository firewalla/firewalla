# node-whois

Whois client for Node.js

## Simple Usage

```javascript
var whois = require('./index.js');

whois.lookup('mokoko.org', {host: 'whois.pir.org'}, function(err, resp, raw) {
    if (err) throw err;
    
    console.log(resp);
});
```
