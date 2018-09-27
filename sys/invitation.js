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
'use strict';

let log = require('../net2/logger.js')(__filename);

let uuid = require("uuid");

let intercomm = require('../lib/intercomm.js');
let utils = require('../lib/utils.js');
let network = require('network');
let qrcode = require('qrcode-terminal');

let bone = require("../lib/Bone.js");

let Promise = require('bluebird');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

const exec = require('child-process-promise').exec;

let networkTool = require('../net2/NetworkTool')();

let license = require('../util/license.js');

const rclient = require('../util/redis_manager.js').getRedisClient()

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

let FW_SERVICE = "Firewalla";
let FW_SERVICE_TYPE = "fb";
let FW_ENDPOINT_NAME = "netbot";

let defaultCheckInterval = 3; // 3 seconds
let defaultTotalTimeout = 60*60;

class FWInvitation {

  constructor(cloud, gid, symmetrickey) {
    this.cloud = cloud;
    this.gid = gid
    this.symmetrickey = symmetrickey
    this.totalTimeout = defaultTotalTimeout;
    this.checkInterval = defaultCheckInterval;
    this.recordFirstBinding = true

    // in noLicenseMode, a default password will be used, a flag 'firstTime' needs to be used to tell app side to use default password
    if(symmetrickey.noLicenseMode) {
      this.firstTime = true;
    } else {
      this.firstTime = false;
    }
  }

  displayKey(key) {
    log.info("\n\n-------------------------------\n");
    log.info("If asked by APP type in this key: ", key);
    log.info("\n-------------------------------");
    log.info("\n\nOr Scan this");
    log.info("\n");

    qrcode.generate(key);
  }

  /*
   * This will enable user to scan the QR code
   * bypass the proximity encryption used
   *
   * please keep this disabled for production
   */

  displayInvite(obj) {
      log.info("\n\n-------------------------------\n");
      log.info("Please scan this to get the invite directly.\n\n");
      log.info("\n\n-------------------------------\n");
      let str = JSON.stringify(obj);
      qrcode.generate(str);
  }

  displayLicense(license) {
    if(!license)
      return
    
    log.info("\n\n-------------------------------\n");
    log.info("\n\nLicense QR");
    log.info("\n");
    qrcode.generate(license)
  }

  displayBonjourMessage(msg) {
    if(!msg)
      return

    log.info("\n\n-------------------------------\n");
    log.info("\n\nBonjour Message QR");
    log.info("\n");
    qrcode.generate(JSON.stringify(msg))
  }
  
  validateLicense(license) {

  }

  checkInvitation(rid) {
    return async(() => {
      log.forceInfo(`${this.leftCheckCount} Inviting ${rid} to group ${this.gid}`);
      try {
        this.leftCheckCount--;
        let rinfo = await (this.cloud.eptinviteGroupByRidAsync(this.gid, rid));
        if(!rinfo || !rinfo.value) {
          throw new Error("Invalid rinfo");
        }

        if(!rinfo.evalue) {
          // FIXME: might enforce license in the future
          log.error("License info is not provided by App, maybe app version is too old");
        }

        let eid = rinfo.value;
        let userInfoString = rinfo.evalue;
        let userInfo = null

        if(userInfoString) {
          try {
            userInfo = JSON.parse(userInfoString);
          } catch(err) {
            log.error(`Failed to parse userInfo ${userInfoString} from app side: ${err}`);
          }
        }

        // for backward compatibility, if license length is not greater than 8,
        // it is old license mode, ignore license registration process
        if(userInfo && userInfo.license && userInfo.license.length != 8) {
          // validate license first
          await (bone.waitUntilCloudReadyAsync());
          let infs = await (networkTool.getLocalNetworkInterface())
          if(infs.length > 0) {
            let mac = infs[0].mac_address;

            try {
              let lic = await (bone.getLicenseAsync(userInfo.license, mac));
              if(lic) {
                const types = platform.getLicenseTypes();
                if(types && lic.DATA && lic.DATA.LICENSE && 
                  lic.DATA.LICENSE.constructor.name === 'String' &&
                  !types.includes(lic.DATA.LICENSE.toLowerCase())) {
                   // invalid license 
                   log.error(`Unmatched license! Model is ${platform.getName()}, license type is ${lic.DATA.LICENSE}`);
                   return {
                     status: "pending"
                   };
                } else {
                  log.forceInfo("Got a new license");
                  log.info("Got a new license:", lic, {});
                  await (license.writeLicense(lic));
                }
              }
            } catch(err) {
              log.error("Invalid license");
              return {
                status : "pending"
              }
            }
          }
        }

        let inviteResult = await (this.cloud.eptinviteGroupAsync(this.gid, eid));

        // Record first binding time
        if(this.recordFirstBinding) {
          await (rclient.setAsync('firstBinding', "" + (new Date() / 1000)))
        }
        
        log.forceInfo(`Linked App ${eid} to this device successfully`);        

        return {
          status: "success",
          payload: inviteResult
        };

      } catch(err) {
        if(err != "404") {
          log.error(err, {});
        }

        if (this.leftCheckCount <= 0) {
          log.info("Invitation is expired! No App Linked");
          return {
            status: "expired",
          };
        } else {
          return {
            status: "pending"
          };
        }
      }
    })();
  }

  broadcast(onSuccess, onTimeout) {
    onSuccess = onSuccess || function() {}
    onTimeout = onTimeout || function() {}

    this.checkCount = this.totalTimeout / this.checkInterval;
    log.info(`Check Interval: ${this.checkInterval}`);
    log.info(`Check Count: ${this.checkCount}`);

    this.leftCheckCount = this.checkCount;

    let obj = this.cloud.eptGenerateInvite(this.gid);

    let txtfield = {
        'gid': this.gid,
        'seed': this.symmetrickey.seed,
        'keyhint': 'You will find the key on the back of your device',
        'service': FW_SERVICE,
        'type': FW_SERVICE_TYPE,
        'mid': uuid.v4(),
        'exp': Date.now() / 1000 + this.totalTimeout,
        'licensemode': '1',
    };

    if(this.diag) {
      this.diag.broadcastInfo = txtfield
    }

    if (intercomm.bcapable()==false) {
      txtfield.verifymode = "qr";
    } else {
      intercomm.bpublish(this.gid, obj.r, FW_SERVICE_TYPE);
    }

    if(this.firstTime) {
      txtfield.firsttime = '1'
    }

    txtfield.ek = this.cloud.encrypt(obj.r, this.symmetrickey.key);

    txtfield.model = platform.getName();

    this.displayLicense(this.symmetrickey.license)
    this.displayKey(this.symmetrickey.userkey);
//    this.displayInvite(obj); // no need to display invite in firewalla any more

    network.get_private_ip((err, ip) => {
        txtfield.ipaddress = ip;

        log.info("TXT:", txtfield, {});
        const serial = platform.getBoardSerial();
        this.service = intercomm.publish(null, FW_ENDPOINT_NAME + serial, 'devhi', 8833, 'tcp', txtfield);
        this.displayBonjourMessage(txtfield)
    });

    if (intercomm.bcapable() != false) {
      intercomm.bpublish(gid, obj.r, config.serviceType);
    }

    const cmd = "awk '{print $1}' /proc/uptime";
    (async () => {
      try {
        const result = await exec(cmd);
        const stdout = result.stdout;
        const stderr = result.stderr;
        if (stderr) {
          log.warn("Unexpected result of uptime: " + stderr);
        }
        if (stdout) {
          const seconds = stdout.replace(/\n$/, '');
          log.forceInfo("Time elapsed since system boot: " + seconds);
        }
      } catch (err) {
        log.warn("Failed to get system uptime.", err);
      }
    })();
    let timer = setInterval(() => {
      async(() => {
        let rid = obj.r;
        let result = await (this.checkInvitation(rid));
        switch(result.status) {
          case "success":
            this.stopBroadcast();
            clearInterval(timer);
            onSuccess(result.payload)
          break;
          case "expired":
            this.stopBroadcast();
            clearInterval(timer);
            onTimeout();
          break;
          default:
            // do nothing;
          break;
        }
      })();
    }, this.checkInterval * 1000);
  }

  stopBroadcast() {
    this.service && intercomm.stop(this.service);
    intercomm.bcapable() && intercomm.bstop();
    intercomm.bye();
  }
}

module.exports = FWInvitation;
