'use strict';

var natUpnp = require('nat-upnp');

var client = natUpnp.createClient();

/*
client.portMapping({
  protocol: 'udp',
  public: 1194,
  private: 1194,
  ttl: 0
}, function(err) {
  // Will be called once finished 
});
*/

/*
client.portUnmapping({
  public:1194 
});
*/

setInterval(() => {
    client.getMappings(function (err, results) {
        console.log(results);
    });
}, 5000);

client.getMappings({
    local: true
}, function (err, results) {});

client.externalIp(function (err, ip) {
    console.log(ip);
});