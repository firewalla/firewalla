/*    Copyright 2016-2022 Firewalla Inc.
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

const sysManager = require('../net2/SysManager.js');
const era = require('../event/EventRequestApi.js');
const Constants = require('../net2/Constants.js');

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

  async checkLocalInvitation() {
    const key = "firekick:local:payload";
    const payload = await rclient.getAsync(key);
    if(!payload) {
      return null;
    }

    try {
      const invite = JSON.parse(payload);
      if(invite.ts) {
        const procStartTime = Math.floor(new Date() / 1000) - process.uptime();
        if (Number(invite.ts) >= procStartTime) {
          // Only process local payload if the generation time of the payload is older than firekick process
          // this is to ensure the existing running firekick won't process the payload
          return null;
        }
      }

      await rclient.delAsync(key); // this should always be used only once

      if(invite.eid && invite.license) {
        const isValid = await this.isLocalLicenseValid(invite.license);

        if(!isValid) {
          log.info("License is not valid, ignore");
          await rclient.setAsync("firereset:error", "invalid_license");
          return null;
        }

        log.info("Going to pair through local:", invite.eid);
        return {
          value: invite.eid,
          evalue: JSON.stringify({
            license: invite.license
          })
        };
      } else {
        return null;
      }
    } catch(err) {
      log.forceInfo("Invalid local payload:", payload)
      await rclient.setAsync("firereset:error", "invalid_license");
      await rclient.delAsync(key); // this should always be used only once
      return null
    }
  }

  // check if the temperary license is valid
  async isLocalLicenseValid(targetLicense) {
    const licenseJSON = await license.getLicenseAsync();
    const tempLicense = await rclient.getAsync("firereset:license");
    const licenseString = licenseJSON && licenseJSON.DATA && licenseJSON.DATA.UUID;

    if(!tempLicense || !targetLicense) {
      log.forceInfo("License info not exist");
      return false;
    }

    if(tempLicense !== targetLicense) {
      log.forceInfo("Unmatched License:", tempLicense.substring(0,8), targetLicense.substring(0,8));
      return false;
    }

    if(!licenseString) {
      return true;
    }

    if(licenseString !== targetLicense) {
      log.forceInfo("Unmatched License 2:", licenseString.substring(0,8), targetLicense.substring(0,8));
      return false;
    }

    return true;
  }

  // check if the temperary license information in redis should be cleaned
  async cleanupTempLicenseInfo() {
    const licenseJSON = await license.getLicenseAsync();
    const tempLicense = await rclient.getAsync("firereset:license");
    const licenseString = licenseJSON && licenseJSON.DATA && licenseJSON.DATA.UUID;

    if(!tempLicense) {
      log.info("No need to remove if not existing")
      return;
    }

    if(!licenseString) { // always remove if no license has been fully registered in firekick
      log.forceInfo("Cleaning temp license cache");
      await rclient.delAsync("firereset:license");
      return;
    }

    if(licenseString !== tempLicense) {
      log.forceInfo("Cleaning unmatched temp license cache");
      await rclient.delAsync("firereset:license"); // remove if they are different
    }

  }

  async checkInvitation(rid) {
    log.forceInfo(`${this.leftCheckCount} Inviting ${rid} to group ${this.gid}`);
    try {
      this.leftCheckCount--;
      let rinfo = await this.checkLocalInvitation();
      if(rinfo === null) {
        rinfo = await this.cloud.eptinviteGroupByRid(this.gid, rid);
      }
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
        const mac = await networkTool.getIdentifierMAC();
        if (!mac)
          return {
            status: "pending"
          };
        try {
          let lic = await bone.getLicenseAsync(userInfo.license, mac);
          if (lic) {
            const types = platform.getLicenseTypes();
            if (types && lic.DATA && lic.DATA.LICENSE &&
              lic.DATA.LICENSE.constructor.name === 'String' &&
              !types.includes(lic.DATA.LICENSE.toLowerCase())) {
              // invalid license
              log.error(`Unmatched license! Model is ${platform.getName()}, license type is ${lic.DATA.LICENSE}`);

              await this.cleanupTempLicenseInfo();

              // record license error
              await rclient.setAsync("firereset:error", "invalid_license_type");

              return {
                status: "pending"
              };
            } else {
              log.forceInfo("Got a new license");
              log.info("Got a new license:", lic && lic.DATA && lic.DATA.UUID && lic.DATA.UUID.substring(0, 8));
              await license.writeLicense(lic);
            }
          }
        } catch (err) {
          log.error("Invalid license", err);

          await this.cleanupTempLicenseInfo();

          // record license error
          await rclient.setAsync("firereset:error", "invalid_license");
          
          return {
            status: "pending"
          }
        }

      }

      let inviteResult = await this.cloud.eptInviteGroup(this.gid, eid);

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
      // remove from revoked eid set
      await rclient.sremAsync(Constants.REDIS_KEY_EID_REVOKE_SET, eid);

      // fire an event on phone_paired with eid info
      await era.addActionEvent("phone_paired",1,{"eid":eid});

      log.forceInfo(`Linked App ${eid} to this device successfully`);

      return {
        status: "success",
        payload: inviteResult
      };

    } catch(err) {
      if(err.statusCode != "404") {
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

    let obj = this.cloud.eptGenerateInvite();

    let txtfield = {
      'gid': this.gid,
      'seed': this.symmetrickey.seed,
      'keyhint': '',
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

      txtfield.verifymode = "qr";
  
      if(this.firstTime) {
        txtfield.firsttime = '1'
      }
  
      txtfield.ek = this.cloud.encrypt(obj.r, this.symmetrickey.key);
  
      txtfield.model = platform.getName();
  
  //    this.displayLicense(this.symmetrickey.license)
  //    this.displayKey(this.symmetrickey.userkey);
      //    this.displayInvite(obj); // no need to display invite in firewalla any more
  
      network.get_private_ip((err, ip) => {
        txtfield.ipaddress = ip;
        const ip2 = sysManager.myIp2();
        const otherAddrs = [];
        if (ip2 && iptool.isV4Format(ip2))
          otherAddrs.push(ip2);
        txtfield.ipaddresses = otherAddrs.join(",");
  
        if(obj.r && obj.r.length > 4) {
          txtfield.rr = obj.r.substring(0,4);
        }
  
        log.info("TXT:", JSON.stringify(txtfield, null, 2));
        const serial = platform.getBoardSerial();
        if (platform.isBonjourBroadcastEnabled()) {
          this.intercomm = require('../lib/intercomm.js')(icOptions);
          this.service = this.intercomm.publish(null, FW_ENDPOINT_NAME + serial, 'devhi', 8833, 'tcp', txtfield);
        }
        
  //      this.displayBonjourMessage(txtfield);
        this.storeBonjourMessage(txtfield);
      });
  
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

    await platform.ledReadyForPairing();
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
    if(platform.isBonjourBroadcastEnabled() && this.intercomm) {
      this.service && this.intercomm.stop(this.service);
      this.intercomm.bye();
    }
    this.unsetBonjourMessage();
  }
}

module.exports = FWInvitation;
