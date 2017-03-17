"use strict"
var express = require('express');
var router = express.Router();
const passport = require('passport')

var Encryption = require('../lib/Encryption'); // encryption middleware
var encryption = new Encryption();

var CloudWrapper = require('../lib/CloudWrapper');
var cloudWrapper = new CloudWrapper();



let f = require('../../net2/Firewalla.js');

let log = require('../../net2/logger.js')(require('path').basename(__filename), "info");

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
      log.info("A new request");
      log.info("================= request body =================");
      log.info(JSON.stringify(req.body, null, '\t'));
      log.info("================= request body end =================");
        
      var gid = req.params.gid;
      let controller = cloudWrapper.getNetBotController(gid);

      if(!controller) {
	res.status(404).send('');
	return;
      }
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
          log.info("Got response, length: ", JSON.stringify(response).length);
          res.json(response);
        }
      });
    }
);

module.exports = router;
