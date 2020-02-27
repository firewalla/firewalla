#!/usr/bin/env node

/*    Copyright 2016 Firewalla LLC 
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
const fs = require('fs');
const cloud = require('../encipher');
const program = require('commander');

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

console.log("---------------------------------");
console.log("Initializing Service ", config.service, config.version, "end point ", eptname);
console.log("---------------------------------");

var eptcloud = new cloud(eptname, config.eptdir);

(async () => {
  const result = await eptcloud.eptLogin(config.appId, config.appSecret, null, eptname)
    .catch(err => {
      console.log("EptCloud Login failed", err);
      process.exit(1);
    })

  const ept = await eptcloud.eptFind(result)
  console.log("Success logged in", result, ept);
  const groups = await eptcloud.eptGroupList(eptcloud.eid)
  console.log("Groups found ", groups);

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
    if (!controller) {}
  }

})()
