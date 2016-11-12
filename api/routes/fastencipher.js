var express = require('express');
var router = express.Router();

var Config = require('../../lib/Config.js');

var Firewalla = require('../../net2/Firewalla.js');
var f = new Firewalla("config.json", 'info');

var jsonfile = require('jsonfile');

// FIXME, hard coded config file location
var configFileLocation = "/encipher.config/netbot.config";

var config = jsonfile.readFileSync(configFileLocation);
if (config == null) {
    console.log("Unable to read config file");
    process.exit(1);
}

var eptname = config.endpoint_name;
var cloud = require('../../encipher');

var eptcloud = new cloud(eptname);

/* fast encipher api */
router.get('/config', function(req, res, next) {
    res.json(
//        ss.readConfig()
    );
});

module.exports = router;
