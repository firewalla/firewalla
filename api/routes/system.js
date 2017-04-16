'use strict';

var express = require('express');
var router = express.Router();
const passport = require('passport')

var SysManager = require('../../net2/SysManager.js');
var sysManager = new SysManager('info');

let sysInfo = require('../../extension/sysinfo/SysInfo.js');

/* system api */
router.get('/info', 
//    passport.authenticate('bearer', { session: false }),
           function(req, res, next) {             
        res.json({
          ip_address: sysManager.myIp(),
          mac_address: sysManager.myMAC(),
          gateway: sysManager.myGateway(),
          subnet: sysManager.mySubnet(),
          dns: sysManager.myDNS(),
          ddns: sysManager.myDDNS(),
        });
    });

router.get('/flow',
    function(req, res, next) {
        
    });

router.get('/perfstat',
          function(req, res, next) {
            sysInfo.getPerfStats((err, stat) => {
              if(err) {
                res.status(500);
                res.send('server error');
                return;
              }
              
              res.json(stat);
            });
          });

module.exports = router;
