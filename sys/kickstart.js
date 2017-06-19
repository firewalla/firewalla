#!/usr/bin/env node
'use strict';
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

/* 
 * Kickstart()  
 * 
 * Create default endpoints                 
 * Create default group
 * 
 * Launch camera app
 *
 * bonjour endpoint information
 * 
 * name: 'Encipher:'+eptname
 * type: 'http'
 * port: '80'
 * txt: {
 *         'gid':'group id',   
 *         'er':'encrypted rendezvous key',
 *         'keyhint':'Please enter the CPU id of your device pasted on a sticker'.
 *      }
 * 
 * setup redenzvous at rndezvous key
 * query every x min until group is none empty, or first invite
 */

process.title = "FireKick";
let log = require("../net2/logger.js")(__filename);

var fs = require('fs');
var cloud = require('../encipher');
var program = require('commander');
var qrcode = require('qrcode-terminal');
var storage = require('node-persist');
var mathuuid = require('../lib/Math.uuid.js');
var utils = require('../lib/utils.js');
var uuid = require("uuid");
var forever = require('forever-monitor');
var intercomm = require('../lib/intercomm.js');
let network = require('network');
var redis = require("redis");
var rclient = redis.createClient();
let SSH = require('../extension/ssh/ssh.js');
let ssh = new SSH('info');

let f = require('../net2/Firewalla.js');

let SysManager = require('../net2/SysManager.js');
let sysManager = new SysManager();
let firewallaConfig = require('../net2/config.js').getConfig();
sysManager.setConfig(firewallaConfig);

let Discovery = require('../net2/Discovery.js');
let discovery = new Discovery("Discovery", firewallaConfig, 'info', true);

// This is required to start early so that all other components can use
// the discovered information as soon as possible
discovery.startDiscover(true, () => {
  discovery = null; // invalidate discovery after one-time scan
});

setTimeout(() => {
  discovery = null; // code to ensure discovery is set to null finally
}, 30000);


const license = require('../util/license.js');

program.version('0.0.2')
    .option('--config [config]', 'configuration file, default to ./config/default.config')
    .option('--admin_invite_timeout [admin_invite_timeout]', 'admin invite timeout');

program.parse(process.argv);

if (program.config == null) {
    log.info("config file is required");
    process.exit(1);
}
let _license = license.getLicense();

var configfile = fs.readFileSync(program.config, 'utf8');
if (configfile == null) {
    log.info("Unable to read config file");
}
var config = JSON.parse(configfile);
if (!config) {
    log.info("Error processing configuration information");
}
if (!config.controllers) {
    log.info("Controller missing from configuration file");
    process.exit(1);
}

var eptname = config.endpoint_name;
if (config.endpoint_name != null) {
    eptname = config.endpoint_name;
} else if (program.endpoint_name != null) {
    eptname = program.endpoint_name;
}

var adminInviteInterval = 2; // default 3 seconds, make it sooner
var adminTotalInterval = 60*60;
var adminInviteTtl= adminTotalInterval / adminInviteInterval; // default 1 hour

function getUserHome() {
    return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
}

var dbPath = getUserHome() + "/.encipher/db";
var configPath = getUserHome() + "/.encipher";

if (!fs.existsSync(configPath)) {
    fs.mkdirSync(configPath);
}
if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath);
}

var symmetrickey = generateEncryptionKey();


var eptcloud = new cloud(eptname, null);
eptcloud.debug(false);
var service = null;

storage.initSync({
    'dir': dbPath
});

function pad(value, length) {
    return (value.toString().length < length) ? pad("0" + value, length) : value;
}


function generateEncryptionKey() {
    var cpuid = null;
    if (_license && _license.SUUID) {
        cpuid = _license.SUUID;
    } else {
        cpuid = utils.getCpuId();
    }
    if (cpuid) {
        var seed = mathuuid.uuidshort(32 - cpuid.length);
        var key = cpuid + seed;
        var userkey = cpuid;
        return {
            'key': key,
            'seed': seed,
            'userkey': userkey
        };
    }
    return null;
}

function initializeGroup(callback) {

    let groupId = storage.getItemSync('groupId');
    if (groupId != null) {
        log.info("Found stored group x", groupId);
        callback(null, groupId);
        return;
    }

    log.info("Creating new group ", config.service, config.endpoint_name);
    var meta = JSON.stringify({
        'type': config.serviceType,
        'member': config.memberType,
    });
    eptcloud.eptcreateGroup(config.service, meta, config.endpoint_name, function (e, r) {
        log.info(r);
        if (e == null && r != null) {
            storage.setItemSync('groupId', r);
        }
        callback(e, r);
    });
}

function displayKey(key) {
    log.info("\n\n-------------------------------\n");
    log.info("If asked by APP type in this key: ", key);
    log.info("\n-------------------------------");
    log.info("\n\nOr Scan this");
    log.info("\n");

    var qrcode = require('qrcode-terminal');
    qrcode.generate(key);

}

/* 
 * This will enable user to scan the QR code
 * bypass the proximity encryption used
 * 
 * please keep this disabled for production
 */

function displayInvite(obj) {
    log.info("\n\n-------------------------------\n");
    log.info("Please scan this to get the invite directly.\n\n");
    log.info("\n\n-------------------------------\n");
    var str = JSON.stringify(obj);
    qrcode.generate(str);
}

function openInvite(group,gid,ttl) {
                var obj = eptcloud.eptGenerateInvite(gid);
                var txtfield = {
                    'gid': gid,
                    'seed': symmetrickey.seed,
                    'keyhint': 'You will find the key on the back of your device',
                    'service': config.service,
                    'type': config.serviceType,
                    'mid': uuid.v4(),
                    'exp': Date.now() / 1000 + adminInviteInterval*ttl,
                };
                if (intercomm.bcapable()==false) {
                    txtfield.verifymode = "qr";
                }
                txtfield.ek = eptcloud.encrypt(obj.r, symmetrickey.key);
                displayKey(symmetrickey.userkey);
                displayInvite(obj);

                network.get_private_ip(function(err, ip) {
                    txtfield.ipaddress = ip;
                    service = intercomm.publish(null, config.endpoint_name+utils.getCpuId(), 'devhi', 8833, 'tcp', txtfield);
                });

                intercomm.bpublish(gid, obj.r, config.serviceType);

                var timer = setInterval(function () {
                    log.info("Open Invite Start Interal", ttl , "Inviting rid", obj.r);
                    eptcloud.eptinviteGroupByRid(gid, obj.r, function (e, r) {
                        log.info("Interal", adminInviteTtl, "gid", gid, "Inviting rid", obj.r, e, r);
                        ttl--;
                        if (!e) {
                          clearInterval(timer);
                          intercomm.stop(service);
                          intercomm.bstop();

                          log.info("EXIT KICKSTART AFTER JOIN");
                          require('child_process').exec("sudo systemctl stop firekick"  , (err, out, code) => {
                          });
                        }
                        if (ttl <= 0) {
                            clearInterval(timer);
                            intercomm.stop(service);
                            intercomm.bstop();
                            log.info("EXIT KICKSTART");
                            require('child_process').exec("sudo systemctl stop firekick"  , (err, out, code) => {
                            });
                        }
                    });
                }, adminInviteInterval * 1000);

}

function postAppLinked() {
  // When app is linked, to secure device, ssh password will be
  // automatically reset when boot up every time
  
  // only do this in production and always do after 15 seconds ...
  // the 15 seconds wait is for the process to wake up

  if(f.isProduction()) {
    setTimeout(()=> {
      ssh.resetRandomPassword((err,password) => {
        if(err) {
          console.log("Failed to reset ssh password");
        } else {
          console.log("A new random SSH password is used!");
          sysManager.sshPassword = password;
        }
      });
    }, 15000);
  }
}

function inviteFirstAdmin(gid, callback) {
    log.info("Initializing first admin");
    eptcloud.groupFind(gid, (err, group)=> {
        if (err) {
            log.info("Error lookiong up group", err);
            callback(err, false);
            return;
        }

        if (group == null) {
            callback("404", false);
            return;
        }

      if (group.symmetricKeys) {
        // number of key sym keys equals to number of members in this group
        // set this number to redis so that other js processes get this info
        rclient.hset("sys:ept", "group_member_cnt", group.symmetricKeys.length);
        
            if (group.symmetricKeys.length === 1) {
//            if (group.symmetricKeys.length > 0) { //uncomment to add more users
                var obj = eptcloud.eptGenerateInvite(gid);
                /*
                eptcloud.eptinviteGroupByRid(gid, obj.r,function(e,r) {
                    log.info("Inviting rid",rid,e,r);
                });  
                */
                var txtfield = {
                    'gid': gid,
                    'seed': symmetrickey.seed,
                    'keyhint': 'You will find the key on the back of your device',
                    'service': config.service,
                    'type': config.serviceType,
                    'mid': uuid.v4(),
                    'exp': Date.now() / 1000 + adminTotalInterval,
                };
                if (intercomm.bcapable()==false) {
                    txtfield.verifymode = "qr";
                }
                txtfield.ek = eptcloud.encrypt(obj.r, symmetrickey.key);
                displayKey(symmetrickey.userkey);
                displayInvite(obj);

                network.get_private_ip(function(err, ip) {
                    txtfield.ipaddress = ip;
                    service = intercomm.publish(null, config.endpoint_name + utils.getCpuId(), 'devhi', 8833, 'tcp', txtfield);
                });

                intercomm.bpublish(gid, obj.r, config.serviceType);

                var timer = setInterval(function () {
                    log.info("Start Interal", adminInviteTtl, "Inviting rid", obj.r);
                    eptcloud.eptinviteGroupByRid(gid, obj.r, function (e, r) {
                      log.info("Interal", adminInviteTtl, "gid", gid, "Inviting rid", obj.r, e, r);
                      adminInviteTtl--;
                      if (!e) {
                        postAppLinked(); // a new member (app) joined
                        rclient.hset("sys:ept", "group_member_cnt", group.symmetricKeys.length + 1);
                        callback(null, true);
                        clearInterval(timer);
                        intercomm.stop(service);
                      }
                      if (adminInviteTtl <= 0) {
                        callback("404", false);
                        clearInterval(timer);
                        intercomm.stop(service);
                        intercomm.bstop();
                      }
                    });
                }, adminInviteInterval * 1000);


            } else {
              postAppLinked(); // already linked
              openInvite(group,gid,90);
              log.info("Found Group ", gid, "with", group.symmetricKeys.length, "members");
              callback(null, true);
            }
        }
    });
}

//forever start raspberrycamera.js --interval 1800 --gid 383fa681-1e0d-4542-99c4-47f3c80e5462 --appid com.rottiesoft.circle --secre
//t fbb05afa-9145-41f1-8076-9de8be56f104 --endpoint_name "raspberry3 monitor" --path /tmp/image2.jpg --beepmsg 'rasbot got image'
function launchService(gid, callback) {
    var args = ['--gid', gid, '--config', program.config];
    log.info("Launching Service", gid, config.appId, config.appSecret, config.endpoint_name, 'args', args);

    var child = new(forever.Monitor)('../controllers/MomBot.js', {
        max: 30,
        silent: false,
        outFile: "/tmp/forever.out",
        logFile: "/tmp/forever.log",
        errFile: "/tmp/forever.err",
        args: args
    });


    child.on('watch:restart', function (info) {
        console.error('Restaring script because ' + info.file + ' changed');
    });

    child.on('restart', function () {
        console.error('Forever restarting script for ' + child.times + ' time');
    });

    child.on('exit:code', function (code) {
        console.error('Forever detected script exited with code ' + code);
    });


    child.start();

}

function launchService2(gid,callback) {
  fs.writeFileSync('/home/pi/.firewalla/ui.conf',JSON.stringify({gid:gid}),'utf-8');

  // don't start bro until app is linked
  require('child_process').exec("sudo systemctl start brofish");
  require('child_process').exec("sudo systemctl enable brofish"); // even auto-start for future reboots

  // start fire api
   if (require('fs').existsSync("/tmp/FWPRODUCTION")) {
       require('child_process').exec("sudo systemctl start fireapi");
   } else {
     if (fs.existsSync("/.dockerenv")) {
       require('child_process').exec("cd api; forever start -a --uid api bin/www");
     } else {
       require('child_process').exec("sudo systemctl start fireapi");
     }
   }
}

eptcloud.eptlogin(config.appId, config.appSecret, null, config.endpoint_name, function (err, result) {
    if (err == null) {
        initializeGroup(function (err, gid) {
            var groupid = gid;
            if (gid) {
                rclient.hmset("sys:ept", {
                    eid: eptcloud.eid,
                    token: eptcloud.token,
                    gid: gid
                }, (err, data) => {
                  if (err) {}
                  log.info("Set SYS:EPT", err, data,eptcloud.eid, eptcloud.token, gid);
                });

                inviteFirstAdmin(gid, function (err, status) {
                    if (status) {
                        intercomm.stop(service);
                        intercomm.bye();
                        launchService2(groupid, null);
                    }
                });
            } else {
                process.exit();
            }
        });
    } else {
        log.info("Unable to login", err);
        process.exit();
    }
});

process.stdin.resume();

intercomm.discover(null, ['devhi', 'devinfo'], function (type, name, txt) {
    log.info("DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDdd");
    log.info(type, name, txt);
    if (type == 'devinfo') {
        if ('sensor' in txt) {}
    }
});

function exitHandler(options, err) {
    intercomm.stop(service);
    if (err) log.info(err.stack);
    if (options.exit) process.exit();
}

//do something when app is closing
process.on('exit', exitHandler.bind(null, {
    cleanup: true
}));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {
    exit: true
}));
