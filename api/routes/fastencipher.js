"use strict"
var express = require('express');
var router = express.Router();

var Config = require('../../lib/Config.js');

let Firewalla = require('../../net2/Firewalla.js');
let f = new Firewalla("config.json", 'info');
let fHome = f.getFirewallaHome();

var jsonfile = require('jsonfile');

// FIXME, hard coded config file location
var configFileLocation = "/encipher.config/netbot.config";

var config = jsonfile.readFileSync(configFileLocation);
if (config == null) {
    console.log("Unable to read config file");
    process.exit(1);
}

var eptname = config.endpoint_name;
var appId = config.appId;
var appSecret = config.appSecret;
var gid = "PASTE_GID_HERE"; // Hard coded, need fix..
var cloud = require('../../encipher');

var eptcloud = new cloud(eptname);
var nbController = null;

// Initialize cloud and netbot controller
eptcloud.eptlogin(appId, appSecret, null, eptname, function(err, result) {
    if(err) {
        console.log("Failed to login encipher cloud: " + err);
        process.exit(1);
    } else {
       eptcloud.eptFind(result, function (err, ept) {
            console.log("Success logged in", result, ept);
            eptcloud.eptGroupList(eptcloud.eid, function (err, groups) {
                console.log("Groups found ", err, groups);
                let NetBotController = require("../../controllers/netbot.js");
                let nbConfig = jsonfile.readFileSync(fHome + "/controllers/netbot.json");
                nbConfig.controller = config.controllers[0];
                nbController = new NetBotController(nbConfig, config, eptcloud, groups, gid, true);
                if(nbController) {
                    console.log("netbot controller is intialized successfully");
                }
            });
        }); 
    }
});

/* fast encipher api */
router.get('/ping', function(req, res, next) {
    res.send("pong!");
});

router.post('/message', function(req, res, next) {
    var message = req.body.message;
    eptcloud.receiveMessage(gid, message, (err, decryptedMessage) => {
        if(err) {
            console.log("Got error: " + err);
            res.send("message failed");
        } else {
            decryptedMessage.mtype = decryptedMessage.message.mtype;
            nbController.msgHandler(gid, decryptedMessage, (err, response) => {
                if(err) {
                    res.json({ error: err });
                } else {
                    eptcloud.encryptMessage(gid, JSON.stringify(response), (err, encryptedResponse) => {
                        if(err) {
                            res.json({error: err});
                        } else {
                            res.json({ message : encryptedResponse });
                        }
                    });
                }
            });
        }
    });
});

module.exports = router;
