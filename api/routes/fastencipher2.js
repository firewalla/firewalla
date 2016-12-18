"use strict"
var express = require('express');
var router = express.Router();
const passport = require('passport')

var Encryption = require('../lib/Encryption'); // encryption middleware
var encryption = new Encryption();

var CloudWrapper = require('../lib/CloudWrapper');
var cloudWrapper = new CloudWrapper();

/* fast encipher api */
router.get('/ping', 
    passport.authenticate('bearer', { session: false }),
    function(req, res, next) {
        res.send("pong!");
    });

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
        controller.msgHandler(gid, req.body, (err, response) => {
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
        var gid = req.params.gid;
        let controller = cloudWrapper.getNetBotController(gid);

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
                console.log("got response: " + JSON.stringify(response));
                res.json(response);
            }
        });
    }
);

module.exports = router;
