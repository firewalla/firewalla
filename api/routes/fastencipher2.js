"use strict"
var express = require('express');
var router = express.Router();
const passport = require('passport')

var Encryption = require('../lib/Encryption'); // encryption middleware
var encryption = new Encryption();

var CloudWrapper = require('../lib/CloudWrapper');
var cloudWrapper = new CloudWrapper();

let f = require('../../net2/Firewalla.js');

let log = require('../../net2/logger.js')(__filename, "info");

let sc = require('../lib/SystemCheck.js');

let zlib = require('zlib');

/* IMPORTANT 
 * -- NO AUTHENTICATION IS NEEDED FOR URL /message 
 * -- message is encrypted already 
 */
router.post('/message/:gid',
    sc.isInitialized,
    encryption.decrypt,
    function(req, res, next) {
      let gid = req.params.gid;
      let controller = cloudWrapper.getNetBotController(gid);
      if(!controller) {
        // netbot controller is not ready yet, waiting for init complete
        res.status(503);
        res.json({error: 'Initializing Firewalla Device, please try later'});
        return;
      }
      log.info("================= request from ", req.connection.remoteAddress, " =================");
      log.info(JSON.stringify(req.body, null, '\t'));
      log.info("================= request body end =================");

      let compressed = req.body.compressed;

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
          log.info("encipher unencrypted message size: ", res.body.length, {});
          if(compressed) { // compress payload to reduce traffic
            let input = new Buffer(res.body, 'utf8');
            zlib.deflate(input, (err, output) => {
              if(err) {
                res.status(500).json({ error: err });
                return;
              }

              res.body = JSON.stringify({payload: output.toString('base64')});
              next();
            });
          } else {
            next();
          }
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
        
      let gid = req.params.gid;
      let compressed = req.query.compressed;
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
          let json = JSON.stringify(response);
          log.info("Got response, length: ", json.length);

          if(compressed) { // compress payload to reduce traffic
            let input = new Buffer(json, 'utf8');
            zlib.deflate(input, (err, output) => {
              if(err) {
                res.status(500).json({ error: err });
                return;
              }
              
              res.status(200).json({
                payload: output.toString('base64')
              });
            });
          } else {
            res.json(response);
          }
        }
      });
    }
);

module.exports = router;
