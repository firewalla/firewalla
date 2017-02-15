"use strict"
var express = require('express');
var router = express.Router();
const passport = require('passport')

var Encryption = require('../lib/Encryption'); // encryption middleware
var encryption = new Encryption();

var CloudWrapper = require('../lib/CloudWrapper');
var cloudWrapper = new CloudWrapper();



let f = require('../../net2/Firewalla.js');

/* IMPORTANT 
 * -- NO AUTHENTICATION IS NEEDED FOR URL /message 
 * -- message is encrypted already 
 */
router.post('/message/:gid', 
    encryption.decrypt,
    function(req, res, next) {
      var gid = req.params.gid;
      let controller = cloudWrapper.getNetBotController(gid);
      console.log("================= request body =================");
      console.log(JSON.stringify(req.body, null, '\t'));
      console.log("================= request body end =================");
      
      var alreadySent = false;
      
      controller.msgHandler(gid, req.body, (err, response) => {
        if(alreadySent) {
          return;
        }

        alreadySent = true;
        
        if(err) {
          res.json({ error: err });
          return;
        } else {
          res.body = JSON.stringify(response);
          next();
        }
      });
    },
    encryption.encrypt
);

router.post('/message/cleartext/:gid', 
    passport.authenticate('bearer', { session: false }),
    function(req, res, next) {
      console.log("================= request body =================");
      console.log(JSON.stringify(req.body, null, '\t'));
      console.log("================= request body end =================");
        
      var gid = req.params.gid;
      let controller = cloudWrapper.getNetBotController(gid);

      if(!controller) {
	res.status(404).send('');
	return;
      }
      var alreadySent = false;

      controller.msgHandler(gid, req.body, (err, response) => {
        console.log("XXXXXXXXXXXXXXXXXXXFFFFFFFFFFFFFFFFFFFFF", err, response);
        if(alreadySent) {
          return;
        }
        
        alreadySent = true;
        
        if(err) {
          res.json({ error: err });
          return;
        } else {
          console.log("got response: " + JSON.stringify(response));
          res.json(response);
        }
      });
    }
);

if(! f.isProduction()) {

  let redis = require("redis");
  let rclient = redis.createClient();

  router.get('/rid/temp', function(req, res, next) {
    // return the temp rid key from redis, this temp key will be sent to app side (simulator or app in dev mode)
    // so that the app can use the rid key to pair with the device

    // This is typically used to pair app with device that is not in the same wifi/ethernet network including Docker
    // environment

    let rid = rclient.get("rid.temp");
    res.json({rid: rid});

  });
}


module.exports = router;
