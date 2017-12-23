'use strict';

var natUpnp = require('nat-upnp');
var UPNP = require('../extension/upnp/upnp.js');
var upnp = new UPNP("info", "192.168.2.1");

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

upnp.removePortMapping("udp", 1194,1194,(err)=>{
    client.getMappings(function (err, results) {
        console.log(results);
        upnp.addPortMapping("udp",1194,1194,"Test OpenVPN",(err)=>{
            console.log("====================================");
            client.getMappings(function (err, results) {
                console.log(results);
            });
         
        });
    });
});

/*
client.portUnmapping({
  protocol: 'udp',
  private: 1194,
  public:1194 
});

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
*/
