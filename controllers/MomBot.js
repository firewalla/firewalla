#!/usr/bin/env node

/*    Copyright 2016 Rottiesoft LLC 
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict'
var fs = require('fs');
var cloud = require('../encipher');
var program = require('commander');
var qrcode = require('qrcode-terminal');
var publicIp = require('public-ip');
var builder = require('botbuilder');
var intercomm = require('../lib/intercomm.js');
var Config = require('../lib/Config.js');

var commondialog = require('../lib/commondialog.js');

program.version('0.0.2')
    .option('--config [config]', 'configuration')
    .option('--lconfig [lconfig]', 'local configuration')
    .option('--name [name]', '(optional) name')
    .option('--endpoint_name [endpoint_name]', '(optional) endpoint')
    .option('--gid [gid]', '(optional) group id')

program.parse(process.argv);

if (program.config == null) {
    console.log("config file is required");
    process.exit(1);
}

var configfile = fs.readFileSync(program.config, 'utf8');
if (configfile == null) {
    console.log("Unable to read config file");
}
var config = JSON.parse(configfile);
if (!config) {
    console.log("Error processing configuration information");
}
if (!config.controllers) {
    console.log("Controller missing from configuration file");
    process.exit(1);
}

//var config = new Config(program.config);

var eptname = config.endpoint_name;
if (config.endpoint_name != null) {
    eptname = config.endpoint_name;
} else if (program.endpoint_name != null) {
    eptname = program.endpoint_name;
}

var gid = config.gid;
if (config.gid != null) {
    gid = config.gid;
} else if (program.gid != null) {
    gid = program.gid;
}

if (program.lconfig) {
    let f = fs.readFileSync(program.lconfig,'utf8');
    let parsed = JSON.parse(f);
    gid = parsed.gid;
}

if (gid == null) {
    console.log("default gid is null");
    process.exit(1);
}

console.log("Initializing Service ", config.service, config.version, "end point ", eptname);

var eptcloud = new cloud(eptname, config.eptdir);

eptcloud.eptlogin(config.appId, config.appSecret, null, eptname, function (err, result) {
    if (err == null) {
        eptcloud.eptFind(result, function (err, ept) {
            console.log("Success logged in", result, ept);
            eptcloud.eptGroupList(eptcloud.eid, function (err, groups) {
                console.log("Groups found ", err, groups);
                for (let i in config.controllers) {
                    let controllerConfigFileName = config.controllers[i].config;
                    let controllerConfig = JSON.parse(fs.readFileSync(controllerConfigFileName, 'utf8'));
                    console.log(controllerConfig.main);
                    if (controllerConfig == null || controllerConfig.main == null) {
                        console.log("Unable to read configuration from file", controllerConfigFileName, controllerConfig);
                        process.exit(1);
                    }
                    controllerConfig.controller = config.controllers[i];
                    let controllerClass = require("../controllers/" + controllerConfig.main);
                    let controller = new controllerClass(controllerConfig, config, eptcloud, groups, gid, true);
                    if (controller == null) {}
                }
            });
        });
    } else {
        console.log("EptCloud Login failed");
        process.exit(1);
    }
});

process.on('uncaughtException',(err)=>{
    console.log("################### CRASH #############");
    console.log("+-+-+-",err.message,err.stack);
    if (err && err.message && err.message.includes("Redis connection")) {
        return;
    }
    bone.log("error",{version:config.version,type:'FIREWALLA.UI.exception',msg:err.message,stack:err.stack},null);
    setTimeout(()=>{
        process.exit(1);
    },1000*2);
});
