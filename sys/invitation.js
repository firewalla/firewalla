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

let Promise = require('bluebird');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let FW_SERVICE = "Firewalla";
let FW_SERVICE_TYPE = "fb";
let FW_ENDPOINT_NAME = "netbot";

let defaultCheckInterval = 2; // 2 seconds
let defaultTotalTimeout = 60*60;

class FWInvitation {

  constructor(cloud, gid, symmetrickey) {
    this.cloud = cloud;
    this.gid = gid
    this.symmetrickey = symmetrickey
    this.totalTimeout = defaultTotalTimeout;
    this.checkInterval = defaultCheckInterval;
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

  checkInvitation(rid) {
    return new Promise((resolve, reject) => {
      log.info(`Inviting ${rid} to group ${this.gid}`);
      this.cloud.eptinviteGroupByRid(this.gid, rid, (e, r) => {

        this.leftCheckCount--;

        if (!e) {
          log.info(`Invitation Success! Linked to App: ${require('util').inspect(r)}`)
          resolve({
            status: "success",
            payload: r
          });
        } else if (this.leftCheckCount <= 0) {
          log.info("Invitation is expired! No App Linked");
          resolve({
            status: "expired",
          });
        } else {
          resolve({
            status: "pending"
          });
        }
      });
    });
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
        'seed': this.symmetrickey,
        'keyhint': 'You will find the key on the back of your device',
        'service': FW_SERVICE,
        'type': FW_SERVICE_TYPE,
        'mid': uuid.v4(),
        'exp': Date.now() / 1000 + this.totalTimeout,
    };

    if (intercomm.bcapable()==false) {
      txtfield.verifymode = "qr";
    } else {
      intercomm.bpublish(this.gid, obj.r, FW_SERVICE_TYPE);
    }

    txtfield.licenseMode = true;

    txtfield.ek = this.cloud.encrypt(obj.r, this.symmetrickey.key);

    this.displayKey(this.symmetrickey.userkey);
    this.displayInvite(obj);

    network.get_private_ip((err, ip) => {
        txtfield.ipaddress = ip;
        this.service = intercomm.publish(null, FW_ENDPOINT_NAME + utils.getCpuId(), 'devhi', 8833, 'tcp', txtfield);
    });

    if (intercomm.bcapable() != false) {
      intercomm.bpublish(gid, obj.r, config.serviceType);
    }

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
