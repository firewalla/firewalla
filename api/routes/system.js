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
            gateway: sysManager.myGateway(),
            subnet: sysManager.mySubnet(),
            dns: sysManager.myDNS(),
            ddns: sysManager.myDDNS()
        });
    });

router.get('/flow',
    function(req, res, next) {
        
    });

module.exports = router;
