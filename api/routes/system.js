var express = require('express');
var router = express.Router();
const passport = require('passport')


var SysManager = require('../../net2/SysManager.js');
var sysManager = new SysManager('info');

/* system api */
router.get('/info', 
    passport.authenticate('bearer', { session: false }),
    function(req, res, next) {
        console.log(require('util').inspect(sysManager));
        
        res.json({
            ip_address: sysManager.myIp(),
            mac_address: sysManager.myMAC(),
            gateway: '10.0.2.1',
            subnet: '255.255.255.0',
            dns: [ '8.8.8.8', '8.8.4.4' ],
            ddns: sysManager.myDDNS()
        });
    });

module.exports = router;
