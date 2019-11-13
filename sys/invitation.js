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

const log = require('../net2/logger.js')(__filename);

const uuid = require("uuid");


const { delay } = require('../util/util.js');
const network = require('network');
const qrcode = require('qrcode-terminal');

const bone = require("../lib/Bone.js");

const exec = require('child-process-promise').exec;

const networkTool = require('../net2/NetworkTool')();

const license = require('../util/license.js');

const rclient = require('../util/redis_manager.js').getRedisClient()

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const iptool = require('ip');

const clientMgmt = require('../mgmt/ClientMgmt.js');

const config = require('../net2/config.js').getConfig();

const SysManager = require('../net2/SysManager.js');
const sysManager = new SysManager();

const FW_SERVICE = "Firewalla";
const FW_SERVICE_TYPE = "fb";
const FW_ENDPOINT_NAME = "netbot";

const defaultCheckInterval = 3; // 3 seconds
const defaultTotalTimeout = 60*60;

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
    const copy = JSON.parse(JSON.stringify(msg));
    copy.type = "pairing";
    qrcode.generate(JSON.stringify(copy))
  }

  async storeBonjourMessage(msg) {
    const key = "firekick:pairing:message";
    await rclient.setAsync(key, JSON.stringify(msg));
    await rclient.expireAsync(key, this.totalTimeout);
  }

  async unsetBonjourMessage() {
    const key = "firekick:pairing:message";
    return rclient.delAsync(key);
  }

  async checkInvitation(rid) {
    log.forceInfo(`${this.leftCheckCount} Inviting ${rid} to group ${this.gid}`);
    try {
      this.leftCheckCount--;
      let rinfo = await this.cloud.eptinviteGroupByRidAsync(this.gid, rid);
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
        await bone.waitUntilCloudReadyAsync();
        let infs = await networkTool.getLocalNetworkInterface()
        if(infs.length > 0) {
          let mac = infs[0].mac_address;

          try {
            let lic = await bone.getLicenseAsync(userInfo.license, mac);
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
                log.info("Got a new license:", lic && lic.DATA && lic.DATA.UUID && lic.DATA.UUID.substring(0, 8));
                await license.writeLicense(lic);
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

      let inviteResult = await this.cloud.eptinviteGroupAsync(this.gid, eid);

      // Record first binding time
      if(this.recordFirstBinding) {
        await rclient.setAsync('firstBinding', "" + (new Date() / 1000))
      }

      // admin or user
      if(this.recordFirstBinding) {
        await clientMgmt.registerAdmin({eid});
      } else {
        await clientMgmt.registerUser({eid});
      }

      log.forceInfo(`Linked App ${eid} to this device successfully`);

      return {
        status: "success",
        payload: inviteResult
      };

    } catch(err) {
      if(err != "404") {
        log.error(err);
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
  }

  async broadcast() {
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
      version: config.version
    };

    if(this.diag) {
      this.diag.broadcastInfo = txtfield
    }

    const myIp = sysManager.myIp();
    const icOptions = {};
    if(myIp) {
      icOptions.interface = myIp;
    }
    
    this.intercomm = require('../lib/intercomm.js')(icOptions);
    
    if (this.intercomm.bcapable()==false) {
      txtfield.verifymode = "qr";
    } else {
      this.intercomm.bpublish(this.gid, obj.r, FW_SERVICE_TYPE);
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
      const ip2 = sysManager.myIp2();
      const otherAddrs = [];
      if (ip2 && iptool.isV4Format(ip2))
        otherAddrs.push(ip2);
      txtfield.ipaddresses = otherAddrs.join(",");

      log.info("TXT:", txtfield);
      const serial = platform.getBoardSerial();
      this.service = this.intercomm.publish(null, FW_ENDPOINT_NAME + serial, 'devhi', 8833, 'tcp', txtfield);
      this.displayBonjourMessage(txtfield);
      this.storeBonjourMessage(txtfield);
    });

    if (this.intercomm.bcapable() != false) {
      this.intercomm.bpublish(this.gid, obj.r, config.serviceType);
    }

    const cmd = "awk '{print $1}' /proc/uptime";
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

    const rid = obj.r;
    while (true) {
      const result = await this.checkInvitation(rid);
      switch(result.status) {
        case "success":
        case "expired":
          this.stopBroadcast();
          return result;
          break;

        default:
          await delay(this.checkInterval * 1000)
          break;
      }
    }
  }

  stopBroadcast() {
    if(this.intercomm) {
      this.service && this.intercomm.stop(this.service);
      this.intercomm.bcapable() && this.intercomm.bstop();
      this.intercomm.bye();
      this.unsetBonjourMessage();      
    }    
  }
}

module.exports = FWInvitation;
