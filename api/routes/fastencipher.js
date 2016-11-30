"use strict"
var express = require('express');
var router = express.Router();
const passport = require('passport')

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
var cloud = require('../../encipher');

var eptcloud = new cloud(eptname);
var nbControllers = {};

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
                groups.forEach(function(group) {
                    let groupID = group.gid;
                    let NetBotController = require("../../controllers/netbot.js");
                    let nbConfig = jsonfile.readFileSync(fHome + "/controllers/netbot.json");
                    nbConfig.controller = config.controllers[0];
                    let nbController = new NetBotController(nbConfig, config, eptcloud, groups, groupID, true);
                    if(nbController) {
                        nbControllers[groupID] = nbController;
                        console.log("netbot controller for group " + groupID + " is intialized successfully");
                    }
                });
            });
        }); 
    }
});

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
router.post('/message/:gid', function(req, res, next) {
    var gid = req.params.gid;
    var message = req.body.message;
    eptcloud.receiveMessage(gid, message, (err, decryptedMessage) => {
        if(err) {
            res.json({"error" : err});
            return;
        } else {
            decryptedMessage.mtype = decryptedMessage.message.mtype;
            let nbController = nbControllers[gid];
            if(!nbController) {
                res.json({"error" : "invalid group id"});
                return;
            }
            nbController.msgHandler(gid, decryptedMessage, (err, response) => {
                if(err) {
                    res.json({ error: err });
                    return;
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
