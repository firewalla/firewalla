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

let ursa = null
const crypto = require('crypto');
const fs = require('fs');
const request = require('requestretry');
const uuid = require("uuid");
const io2 = require('socket.io-client');

const f = require('../../net2/Firewalla.js');
const log = require('../../net2/logger')(__filename);
const Constants = require('../../net2/Constants.js');

const zlib = require('zlib');
const License = require('../../util/license.js');

const config = require('../../net2/config.js');

const fConfig = require('../../net2/config.js').getConfig();
const { delay } = require('../../util/util.js')
const { rrWithErrHandling } = require('../../util/requestWrapper.js')
const rclient = require('../../util/redis_manager.js').getRedisClient()
// const sem = require('../../sensor/SensorEventManager.js').getInstance();
const era = require('../../event/EventRequestApi.js')
const platform = require('../../platform/PlatformLoader.js').getPlatform();

const exec = require('child-process-promise').exec;

const rp = require('request-promise');

const NODE_VERSION_SUPPORTS_RSA = 12
// const NOTIF_ONLINE_INTERVAL = fConfig.timing['notification.box_onlin.cooldown'] || 900
const NOTIF_OFFLINE_THRESHOLD = fConfig.timing['notification.box_offline.threshold'] || 900
const NOTIF_WAN_DOWN_THRESHOLD = fConfig.timing['notification.wan_down.threshold'] || 15
const LED_NETWORK_DOWN_THRESHOLD = fConfig.timing['led.network_down.threshold'] || 10

const util = require('util')

const _ = require('lodash')

let instance = {};

const notificationResendKey = "notification:resend";
const notificationResendDuration = fConfig.timing['notification.resend.duration'] || 86400
const notificationResendMaxCount = fConfig.timing['notification.resend.maxcount'] || 50

function getUserHome() {
  return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
}

let legoEptCloud = class {

  constructor(name, pathname) {
    if (pathname == null) {
      pathname = getUserHome() + "/.encipher/";
      if (!fs.existsSync(pathname)) {
        fs.mkdirSync(pathname);
      }
    }
    this.keyPath = pathname;

    if (!instance[name]) {
      instance[name] = this;
      this.myPublicKey = null;
      this.myPrivateKey = null;
      this.appId = null;
      this.aid = null; // aid is the system wide unique application id (UID of application)
      this.appSecret = null;
      this.info = null; // to be encrypted
      this.signature = "";
      this.endpoint = fConfig.firewallaGroupServerURL || "https://firewalla.encipher.io/iot/api/v2";
      this.sioURL = fConfig.firewallaSocketIOURL || "https://firewalla.encipher.io";
      this.sioPath = fConfig.SocketIOPath;
      if(f.isDevelopmentVersion() || f.isAlpha()) {
        this.endpoint = fConfig.firewallaGroupServerDevURL || "https://firewalla.encipher.io/iot/api/dv2";
        this.sioPath = fConfig.SocketIODevPath;
      }
      this.token = null;
      rclient.hgetAsync('sys:ept:me', 'eid').then(eid => this.eid = eid)
      this.groupCache = {};
      this.cryptoalgorithem = 'aes-256-cbc';
      this.name = name;
      this.errTtl = 2; // only retry x times for bad requests
      this.notifyGids = [];

      this.nodeRSASupport =
        Number.parseFloat(process.versions.node) > NODE_VERSION_SUPPORTS_RSA
      if (!this.nodeRSASupport) {
        ursa = require('ursa');
      }

      this.offlineEventJob = null;
      this.offlineEventFired = false;

      this.disconnectCloud = true;
    }
    return instance[name];
    // NO LONGER create keypair in sync node during constructor
  }

  async keyReady() {
    log.forceInfo("Checking whether key pair:", this.name);

    try {
      await fs.promises.access(this.getPublicKeyPath())
      await fs.promises.access(this.getPrivateKeyPath())
    } catch(err) {
      if(err) {
        log.warn('Fail on reading key files', err)
        return null;
      }
    }

    let pubFile = await fs.promises.readFile(this.getPublicKeyPath())
    let priFile = await fs.promises.readFile(this.getPrivateKeyPath())
    if(pubFile.length < 10 || priFile.length < 10) {
      log.error("ENCIPHER.IO Unable to read keys, keylength error", pubFile.length, priFile.length);
      await this.cleanupKeys()
      return null;
    } else {
      log.forceInfo("Key pair exists");
      return {pub: pubFile, pri: priFile};
    }

  }

  async untilKeyReady() {
    log.forceInfo('Wait until keys ready ...')
    let result = await this.keyReady()
    if (!result) {
      log.info("Keys not ready, wait ...");
      await delay(3000); // wait for three seconds
      return this.untilKeyReady()
    }
    return true;
  }

  mypubkey() {
    return this.mypubkeyfile && this.mypubkeyfile.toString('ascii');
  }

  async cleanupKeys(pathname) {
    log.info("Cleaning up key pairs");

    this.myprivkeyfile = null;
    this.mypubkeyfile = null;
    this.myPublicKey = null;
    this.myPrivateKey = null;

    await exec("sudo rm -f " + pathname + "/db/groupId")
    await exec("sync")
  }

  getPrivateKeyPath() {
    return this.keyPath + this.name + ".privkey.pem";
  }

  getPublicKeyPath() {
    return this.keyPath + this.name + ".pubkey.pem";
  }

  async loadKeys() {
    if (this.myPublicKey && this.myPrivateKey) {
      return
    }

    log.info("Loading keys...");

    if (!this.myprivkeyfile || !this.mypubkeyfile) {
      const keys = await this.keyReady()
      if (keys) {
        this.mypubkeyfile = keys.pub;
        this.myprivkeyfile = keys.pri;
      } else {
        log.info("Keys not exist, creating...");
        await this.createKeyPair();
        return
      }
    }

    if (this.nodeRSASupport) {
      this.myPublicKey = crypto.createPublicKey(this.mypubkeyfile);
      this.myPrivateKey = crypto.createPrivateKey(this.myprivkeyfile);
    } else {
      this.myPublicKey = ursa.createPublicKey(this.mypubkeyfile);
      this.myPrivateKey = ursa.createPrivateKey(this.myprivkeyfile);
    }
    return
  }


  async createKeyPair() {
    if (this.nodeRSASupport) {
      const generateKeyPair = util.promisify(crypto.generateKeyPair)
      const { privateKey, publicKey } = await generateKeyPair(
        'rsa', {modulusLength:2048, publicExponent:65537}
      );
      this.myPrivateKey = privateKey
      this.myPublicKey = publicKey
      this.myprivkeyfile = privateKey.export({type:'pkcs1', format:'pem'})
      this.mypubkeyfile = publicKey.export({type:'spki', format:'pem'})
    } else {
      const key = ursa.generatePrivateKey(2048, 65537);
      this.mypubkeyfile = key.toPublicPem();
      this.myprivkeyfile = key.toPrivatePem();
      this.myPublicKey = ursa.createPublicKey(this.mypubkeyfile);
      this.myPrivateKey = key
    }

    await fs.promises.writeFile(this.getPrivateKeyPath(), this.myprivkeyfile, 'ascii')
    await fs.promises.writeFile(this.getPublicKeyPath(), this.mypubkeyfile, 'ascii')
    await exec("sync")
  }

  publicEncrypt(key, utf8String) {
    if (this.nodeRSASupport) {
      const buffer = Buffer.from(utf8String)
      return crypto.publicEncrypt(key, buffer).toString('base64')
    } else {
      return key.encrypt(utf8String, 'utf8', 'base64');
    }
  }

  privateDecrypt(key, base64String) {
    if (this.nodeRSASupport) {
      const buffer = Buffer.from(base64String, 'base64')
      return crypto.privateDecrypt(key, buffer).toString('utf8')
    } else {
      return key.decrypt(base64String, 'base64', 'utf8');
    }
  }

  // Info is not encrypted
  async eptLogin(appId, appSecret, eptInfo, tag) {
    await this.loadKeys()
    this.appId = appId;
    this.appSecret = appSecret;
    this.eptInfo = eptInfo;
    this.tag = tag;
    this.info = eptInfo;
    const assertion = {
      'assertion': {
        'name': this.tag,
        'publicKey': this.mypubkeyfile.toString('utf8'),
        'appId': this.appId,
        'appSecret': this.appSecret,
        'signature': this.signature,
        'license': License.getLicense()
      }
    };
    if (this.info) {
      assertion.assertion.info = this.info;
    }

    log.info("Encipher URL:", this.endpoint);

    const options = {
      uri: this.endpoint + '/login/eptoken',
      family: 4,
      method: 'POST',

      json: assertion,
      maxAttempts: 5,
      retryDelay: 1000,
    };

    const response = await rrWithErrHandling(options)

    const body = response.body
    this.token = body.access_token;
    this.eid = body.eid;
    this.groups = body.groups;
    this.aid = body.aid;

    return this.eid
  }

  async eptRelogin() {
    return this.eptLogin(this.appId, this.appSecret, this.eptInfo, this.tag);
  }

  eptHandleError(code, callback) {
    if (code == '401' || code == 401) {
      this.eptRelogin().then(() => {
        if (callback)
          callback(202, null);
      }).catch((err) => {
        if (callback)
          callback(code, null);
      });
    } else {
      if (callback) {
        callback(code, null);
      }
    }
  }

  async rrWithEptRelogin(options) {
    options.auth = { bearer: this.token }
    try {
      return rrWithErrHandling(options)
    } catch(err) {
      if (err && err.statusCode == 401) {
        log.verbose('401, re-login')
        await this.eptRelogin();
        return rrWithErrHandling(Object.assign({}, options, { auth: { bearer: this.token } }));
      } else
        throw err;
    }
  }

  async rename(gid, name) {
    if(!gid || !name) {
      return new Error("parameter errors");
    }

    const uri = `${this.endpoint}/group/${this.appId}/${gid}`;
    const key = await this.getKeyAsync(gid);
    const cryptedXNAME = this.encrypt(name, key);

    const body = {
      name: crypto.createHash('md5').update(name).digest('hex'),
      xname: cryptedXNAME
    };

    const options = {
      uri: uri,
      family: 4,
      method: 'POST',
      json: body,
      maxAttempts: 2
    }

    log.info("Setting box name to", name);
    await this.rrWithEptRelogin(options);

    this.groupCache[gid].xname = cryptedXNAME;
    this.groupCache[gid].updatedAt = new Date().toISOString()
    this.groupCache[gid].name = name;

    await rclient.setAsync(Constants.REDIS_KEY_GROUP_NAME, name);

    return name
  }

  async eptCreateGroup(name, info, alias) {
    let symmetricKey = this.keygen();
    let group = {};
    let encryptedSymmetricKey = this.publicEncrypt(this.myPublicKey, symmetricKey);

    if (info) {
      group.info = this.encrypt(info, symmetricKey);
    }

    group.xname = this.encrypt(name, symmetricKey);
    group.name = crypto.createHash('md5').update(name).digest('hex');
    group.symmetricKey = {
      'eid': this.eid,
      'key': encryptedSymmetricKey,
      'effective': 0,
      'expires': 0,
    };

    if (alias) {
      group.symmetricKey.name = this.encrypt(alias, symmetricKey);
    }

    let options = {
      uri: this.endpoint + '/group/' + this.appId,
      family: 4,
      method: 'POST',
      json: group,
      maxAttempts: 3
    };

    const response = await this.rrWithEptRelogin(options)

    return _.get(response, 'body.gid', null)
  }

  async eptFind(eid) {
    const options = {
      uri: this.endpoint + '/ept/' + encodeURIComponent(eid),
      family: 4,
      method: 'GET',
      json: true,
      maxAttempts: 2
    };

    const resp = await this.rrWithEptRelogin(options)

    return resp.body
  }

  async eptGroupList() {
    if (!this.eid) throw new Error('Invalid Instance Eid')

    let options = {
      uri: this.endpoint + '/ept/' + encodeURIComponent(this.eid) + '/groups',
      family: 4,
      method: 'GET',
      json: true,
      maxAttempts: 2
    };

    log.debug("Group search ", options.uri);

    const resp = await this.rrWithEptRelogin(options)

    if (!resp.body)
      throw new Error("Malformed JSON")

    for (const group of resp.body.groups) {
      group.gid = group._id;
      if (group["xname"]) {
        this.parseGroup(group);
      }
    }
    return resp.body.groups; // "groups":groups
  }


  async rendezvousMap(rid) {
    const options = {
      uri: this.endpoint + '/ept/rendezvous/' + rid,
      family: 4,
      method: 'GET',
      json: true,
      maxAttempts: 1
    };

    const resp = await this.rrWithEptRelogin(options)

    return resp.body
  }

  async deleteEidFromGroup(gid, eid) {
    if (!gid || !eid) {
      throw new Error("require gid and eid when deleting eid from group");
    }

    const options = {
      uri: `${this.endpoint}/group/${gid}/${eid}`,
      family: 4,
      method: 'DELETE',
      auth: {
        bearer: this.token
      }
    }

    log.info(`deleting eid ${eid} from group ${gid}`);
    const result = await rp(options);
    log.info(`deleted eid ${eid} from group ${gid}`);
    return result;
  }

  async deleteGroup(gid) {
    if (gid === undefined) {
      throw new Error("parameter error")
    }
    let options = {
      uri: this.endpoint + '/group/' + gid,
      family: 4,
      method: 'DELETE',
      maxAttempts: 3
    }

    log.debug("group delete ", options);

    await this.rrWithEptRelogin(options)
  }

  async groupFind(gid) {

    if (this.appId === undefined || gid === undefined) {
      throw new Error("parameter error");
    }

    const options = {
      uri: this.endpoint + '/group/' + this.appId + "/" + gid,
      family: 4,
      method: 'GET',
      json: true,
      maxAttempts: 2
    };

    log.debug("group find ", options);

    const resp = await this.rrWithEptRelogin(options)

    if(!resp.body) {
      throw new Error("invalid group id " + gid);
    }

    if (_.isString(resp.body)) {
      return null
    }

    this.groupCache[gid] = this.parseGroup(resp.body);
    return this.groupCache[gid]
  }

  parseGroup(group) {
    if (group == null) {
      return null;
    }

    const sk = group.symmetricKeys.find(skey => skey.eid == this.eid)
    if (!sk) {
      return null;
    }

    let symmetricKey = this.privateDecrypt(this.myPrivateKey, sk.key);
    this.groupCache[group._id] = {
      'group': group,
      'symmetricKey': sk,
      'key': symmetricKey,
      'lastfetch': 0,
      'pullIntervalInSeconds': 0,
    };

    if(sk.rkey) {
      try {
        const {ts, ttl, key, sign, nkey, nsign} = JSON.parse(sk.rkey);
        const decryptedKey = this.privateDecrypt(this.myPrivateKey, key);
        const payload = {ts, ttl, key: decryptedKey, sign};

        if(nkey && nsign) {
          const decryptedNKey = this.privateDecrypt(this.myPrivateKey, nkey);
          payload.nkey = decryptedNKey;
          payload.nsign = nsign;
        }
        this.groupCache[group._id].rkey = payload;
      } catch(err) {
        log.error("Got error parsing rkey, err:", err);
      }
    }

    for (const skey of group.symmetricKeys) {
      if (skey.name) {
        skey.displayName = this.decrypt(skey.name, symmetricKey);
      } else if (skey.uid) {
        skey.displayName = skey.uid;
      }
      if (skey.eid == this.eid) {
        group.me = skey;
      }
    }
    if (group.xname) {
      group.name = this.decrypt(group.xname, symmetricKey);
    }

    return this.groupCache[group._id];
  }

  getRKeyTimestamp(gid) {
    const rkey = this.getMaskedRKey(gid);
    return rkey && rkey.ts;
  }

  getMaskedRKey(gid) {
    const group = this.groupCache[gid];
    if(group && group.rkey) {
      const rkeyCopy = JSON.parse(JSON.stringify(group.rkey));
      delete rkeyCopy.key;
      delete rkeyCopy.sign;
      delete rkeyCopy.nkey;
      delete rkeyCopy.nsign;
      return rkeyCopy;
    }

    return {};
  }

  getKey(gid, callback) {
    return util.callbackify(this.getKeyAsync).bind(this)(gid, callback || function(){})
  }

  async getKeyAsync(gid) {
    try {
      let group = this.groupCache[gid];
      if(!group) {
        group = await this.groupFind(gid);
      }

      if(config.isFeatureOn("rekey") &&
         group &&
         group.rkey &&
         group.rkey.key) {
        return group.rkey.key;
      }

      if (group && group.key) {
        return group.key;
      }

    } catch(err) {
      log.error('Error getting group', err.message)

      // network error, using redis cache.
      // don't save result to this.groupCache here
      try {
        const key = await rclient.hgetAsync('sys:ept:me', 'key')
        const symmetricKey = this.privateDecrypt(this.myPrivateKey, key);
        return symmetricKey
      } catch(err) {
        log.error("Error getting local cache", err)
      }
    }

    return null;
  }

  getGroupFromCache(gid) {
    return this.groupCache[gid];
  }

  encrypt(text, key) {
    let iv = Buffer.alloc(16);
    iv.fill(0);
    let bkey = Buffer.from(key.substring(0, 32), "utf8");
    let cipher = crypto.createCipheriv(this.cryptoalgorithem, bkey, iv);
    let crypted = cipher.update(text, 'utf8', 'base64');
    crypted += cipher.final('base64');
    return crypted;
  }

  encryptBinary(data, key) {
    if (data == null) {
      log.error("Error data is null");
      return;
    }
    log.debug('encryting data with size', data.length, data.constructor.name);
    let iv = Buffer.alloc(16);
    iv.fill(0);
    let bkey = Buffer.from(key.substring(0, 32), "utf8");
    let cipher = crypto.createCipheriv(this.cryptoalgorithem, bkey, iv);
    let crypted = cipher.update(data);

    crypted = Buffer.concat([crypted, cipher.final()]);
    log.debug('encryted data with size', crypted.length, crypted.constructor.name);
    return crypted;
  }

  decrypt(text, key) {
    try {
      let iv = Buffer.alloc(16);
      iv.fill(0);
      let bkey = Buffer.from(key.substring(0, 32), "utf8");
      let decipher = crypto.createDecipheriv(this.cryptoalgorithem, bkey, iv);
      let dec = decipher.update(text, 'base64', 'utf8');
      dec += decipher.final('utf8');
      return dec;
    } catch(err) {
      log.error("Failed to decrypt message, err:", err);
      return null;
    }
  }

  keygen() {
    let k = uuid.v4();
    return k.replace('-', '');
  }

  // This is to encrypt message for direct communication between app and pi.
  // The message will not be transferred via cloud
  // just encrypt and send via callback
  encryptMessage(gid, msg, callback) {
    this.getKey(gid, (err, key) => {
      if (err != null && key == null) {
        callback(err, null)
        return;
      }
      let crypted = this.encrypt(msg, key);
      //log.info('encrypted text ', crypted);
      callback(null, crypted);
    });
  }
  /*
   * beep is the structure to send a apn notification
   *    - beep content is not encrypted
   */

  /* _beep
       cmd: 'notify','silent',
       msg: 'message',  // the visible alert, not encrypted
     sound: 'sound to play'
       eid: 'eid'
      data: 'data'  // not encrypted data
      encrypted: encrypted data
      */

  // VALID MTYPE:  jsondata


  _send(gid, msgstr, _beep, mtype, fid, mid, ttl, callback) {

    if(typeof ttl == 'function') {
      callback = ttl
      ttl = 1
    }

    if(ttl <= 0) {
      callback(new Error("ttl expired"), null)
      return
    }

    let self = this;

    log.info("encipher unencrypted message size: ", msgstr.length, "ttl:", ttl);

    this.getKey(gid, async (err, key) => {
      if (err != null && key == null) {
        callback(err, null)
        return;
      }
      log.debug('tag is ', self.tag, 'key is ', key);
      let crypted = self.encrypt(msgstr, key);

      if (_beep && 'encrypted' in _beep) {
        _beep.encrypted = self.encrypt(JSON.stringify(_beep.encrypted), key);
        // _beep.encrypted = self.encrypt((_beep.encrypted),key);
      }

      // log.info('encrypted text ', crypted);
      if (!this.disconnectCloud) {
        const options = {
          uri: self.endpoint + '/service/message/' + self.appId + '/' + gid + '/eptgroup/' + gid,
          family: 4,
          method: 'POST',
          auth: {
            bearer: self.token
          },
          json: {
            'timestamp': Math.floor(Date.now() / 1000),
            'message': crypted,
            'beep': _beep,
            'mtype': mtype,
            'fid': fid,
            'mid': mid,
          },
          maxAttempts: 5,   // (default) try 5 times
          retryDelay: 1000,  // (default) wait for 1s before trying again
        };

        request(options, (err2, httpResponse, body) => {
          if (err2 != null) {
            let stack = new Error().stack;
            log.error("Error while requesting ", err2, stack);
            if(ttl > 1) {
              this._send(gid, msgstr, _beep, mtype, fid, mid, ttl - 1, callback)
            } else {
              callback(err2, null);
            }

            return;
          }
          if (httpResponse.statusCode < 200 ||
            httpResponse.statusCode > 299) {
            this.eptHandleError(httpResponse.statusCode, (code, p) => {
              callback(httpResponse.statusCode, null);
            });
          } else {
            log.debug("send message to group ", body);
            log.debug(body);
            callback(null, body);
          }
        });
      } else {
        const jsonObj = {
          gid: gid,
          msgstr: msgstr,
          _beep: _beep,
          mtype: mtype,
          fid: fid,
          mid: mid
        }
        const jsonStr = JSON.stringify(jsonObj);
        const now = Math.floor(new Date() / 1000)
        await rclient.zaddAsync(notificationResendKey, now, jsonStr);
      }

    });
  }

  sendMsgToGroup(gid, msg, _beep, mtype, fid, mid, callback) {
    log.debug(msg);
    let mpackage = {
      'random': this.keygen(),
      'message': msg,
    };
    if (fid === null) {
      fid = undefined;
    }
    if (mid === null) {
      mid = undefined;
    }
    let msgstr = JSON.stringify(mpackage);

    log.info("message size before compression:", msgstr.length);

    if(msg.data && msg.data.compressMode) {
      // compress before encrypt
      let input = Buffer.from(msgstr, 'utf8');
      zlib.deflate(input, (err, output) => {
        if(err) {
          log.error("Failed to compress payload:", err);
          callback(err);
          return;
        }

        let payload = {
          compressMode: true,
          data: output.toString('base64')
        };

        const compressedPayload = JSON.stringify(payload);

        const before = msgstr.length;
        const after = compressedPayload.length;

        if(before !== 0) {
          const compressRatio = ((before - after) / before * 100).toFixed(1);
          log.info(`Compression enabled, size is reduced by ${compressRatio}%`);
        }

        this._send(gid, compressedPayload, _beep, mtype, fid, mid, 5, callback)
      })
    } else {
      this._send(gid, msgstr, _beep, mtype, fid, mid, 5, callback)
    }

  }

  // Direct one-to-one message handling
  receiveMessage(gid, msg, callback) {
    log.debug("Got encrypted message from group", gid);

    this.getKey(gid, (err, key) => {
      if (err != null && key == null) {
        log.error("Got error when fetching key:", key);
        callback(err, null);
        return;
      }

      if(key == null) {
        log.error("encryption key is not found for group:", gid);
        callback("key not found, invalid group?", null);
        return;
      }

      let decryptedMsg = this.decrypt(msg, key);
      let msgJson = this._parseJsonSafe(decryptedMsg);
      if (msgJson != null) {
        callback(null, msgJson);
      } else {
        callback(new Error("Malformed JSON"), null);
      }
    });
  }

  getMsgFromGroup(gid, timestamp, count, callback) {
    let self = this;
    this.getKey(gid, (err, key) => {
      if (err != null && key == null) {
        callback(err, null);
        return;
      }

      let options = {
        uri: self.endpoint + '/service/message/' + self.appId + "/" + gid + '/eptgroup/' + encodeURIComponent(self.eid) + '?count=' + count + '&peerId=' + gid + '&since=' + timestamp,
        family: 4,
        method: 'GET',
        auth: {
          bearer: self.token
        }
      };

      //log('getmsg from group ',gid,' url ',options.uri);

      request(options, (err2, httpResponse, body) => {
        if (err2 != null) {
          let stack = new Error().stack;
          log.error("Error while requesting ", err2, stack);
          callback(err2, null);
          return;
        }
        if (httpResponse.statusCode < 200 ||
          httpResponse.statusCode > 299) {
          log.error('get msg from group error ', httpResponse.statusCode);
          this.eptHandleError(httpResponse.statusCode, (code, p) => {
            callback(httpResponse.statusCode, null);
          });
          return;
        }

        let bodyJson = this._parseJsonSafe(body);
        if (bodyJson == null) {
          callback(new Error("Malformed JSON"), null);
          return;
        }
        let data = bodyJson.data;
        let messages = [];
        for (let m in data) {
          const obj = data[m];

          if(!obj) {
            continue;
          }

          if (self.eid === obj.fromUid) {
            continue;
          }

          let message = this._parseJsonSafe(self.decrypt(obj.message, key));
          if (message == null) {
            continue;
          }
          messages.push({
            'id': obj.id, // id
            'timestamp': obj.timestamp,
            'mtype': obj.mtype,
            'from': obj.fromName,
            'message': message.message, // text message within the message
            'obj': message, // decoded message
            'fromEid': obj.fromUid,
          });
        }
        callback(err, messages);
      });

    });
  }

  // This will pull messags from now ...
  //
  // if 0 is passed in intervalInSeconds, pulling will stop

  pullMsgFromGroup(gid, intervalInSeconds, callback, boneCallback) {
    log.info('pullMsgFromGroup', gid, intervalInSeconds)
    let self = this;
    let inactivityTimeout = 5 * 60; //5 min
    this.getKey(gid, (err, key) => {
      const group = this.groupCache[gid]
      if (err) log.error('Failed to get key', err)
      if (this.socket == null) {
        this.notifyGids.push(gid);
        log.debug(this.sioURL, this.sioPath)
        this.socket = io2(this.sioURL, {path: this.sioPath, transports: ['websocket'], 'upgrade': false});
        this.socket.on('connect_error', err => {
          this.disconnectCloud = true;
          // only log error the first time to prevent flooding log
          if (!this.offlineEventFired && !this.offlineEventJob) {
            log.error('Failed to connect cloud', err)
            this.offlineEventJob = setTimeout(
              async () => {
                await era.addStateEvent("box_state", "websocket", 1);
                this.offlineEventFired = true;
                this.offlineEventJob = null
              },
              NOTIF_OFFLINE_THRESHOLD * 1000);
          }
        })
        this.socket.on('disconnect', reason => {
          this.disconnectCloud = true;
          log.error('Cloud disconnected:', reason);
          // send a box disconnect event if NOT reconnect after some time
          this.offlineEventJob = this.offlineEventJob || setTimeout(
            async () => {
              await era.addStateEvent("box_state","websocket",1);
              this.offlineEventFired = true;
              this.offlineEventJob = null
            },
            NOTIF_OFFLINE_THRESHOLD*1000);
          if (!platform.isFireRouterManaged()) {
            this.wanDownEventJob = setTimeout(async () => {
              const sysManager = require('../../net2/SysManager.js');
              const wanIntf = sysManager.getDefaultWanInterface();
              const intfName = wanIntf.name;
              const uuid = wanIntf.uuid;
              const ip4s = wanIntf.ip4_addresses;
              const wanStatus = {};
              wanStatus[intfName] = {
                "wan_intf_name": "WAN",
                "wan_intf_uuid": uuid,
                "ready": false,
                "active": false,
                "ip4s": ip4s
              };
              await era.addStateEvent("overall_wan_state", "overall_wan_state", 1, {wanStatus}).catch((err) => {
                log.error(`Failed to create overall_wan_state event`, err.message);
              });;

            }, NOTIF_WAN_DOWN_THRESHOLD * 1000);
          }

          if(!this.ledNetworkDownJob) {
            this.ledNetworkDownJob = setTimeout(() => {
              // set led to notify user
              platform.ledNetworkDown();
              this.ledNetworkDownJob = null;
            }, LED_NETWORK_DOWN_THRESHOLD * 1000);
          }

        });
        this.socket.on("glisten200",(data)=>{
          log.forceInfo(this.name, "SOCKET Glisten 200 group indicator");
        });
        this.socket.on("newMsg",(data)=>{
          this.getMsgFromGroup(gid, data.ts, 100, (err, messages) => {
            group.lastfetch = Date.now() / 1000;
            callback(err,messages);
          });
        });
        this.socket.on("boneMsg",(data)=> {
          console.log("SOCKET boneMsg ");
          if (boneCallback && data) {
            boneCallback(null,data);
          }
        });
        this.socket.on('reconnect', async ()=>{
          log.info('--== Cloud reconnected ==--')
          // if (this.lastDisconnection
          //   && Date.now() / 1000 - this.lastDisconnection > NOTIF_OFFLINE_THRESHOLD
          //   && Date.now() / 1000 - this.lastReconnection > NOTIF_ONLINE_INTERVAL
          // ) {
          //   this.lastReconnection = Date.now() / 1000
          //   sem.sendEventToFireApi({
          //     type: 'FW_NOTIFICATION',
          //     titleKey: 'NOTIF_BOX_ONLINE_TITLE',
          //     bodyKey: 'NOTIF_BOX_ONLINE_BODY',
          //     titleLocalKey: 'BOX_ONLINE',
          //     bodyLocalKey: 'BOX_ONLINE',
          //     payload: {}
          //   });
          // }

          // cancel box offline event
          if ( this.offlineEventJob ) {
            clearTimeout(this.offlineEventJob);
          }

          // clear led job if exists
          if(this.ledNetworkDownJob) {
            clearTimeout(this.ledNetworkDownJob);
            this.ledNetworkDownJob = null;
          }
          // always reset led
          platform.ledNetworkUp();

          // fire box re-connect event ONLY when previously fired an offline event
          if ( this.offlineEventFired ) {
            await era.addStateEvent("box_state","websocket",0);
            this.offlineEventFired = false;
          }
          this.disconnectCloud = false;
          const now = Math.floor(new Date() / 1000)
          const ts = now - notificationResendDuration;
          const results = await rclient.zrangebyscoreAsync(notificationResendKey, '(' + ts, '+inf', 'limit', 0, notificationResendMaxCount);
          for (const result of results) {
            if (result) {
              try {
                const jsonObj = JSON.parse(result)
                const gid = jsonObj.gid;
                const msgstr = jsonObj.msgstr;
                const _beep = jsonObj._beep;
                const mtype = jsonObj.mtype;
                const fid = jsonObj.fid;
                const mid = jsonObj.mid;
                const callback = function(e, r) {}
                this._send(gid, msgstr, _beep, mtype, fid, mid, 5, callback)
              } catch (error) {
                log.error("resend notification error", error)
              }
            }
          }
          await rclient.zremrangebyscoreAsync(notificationResendKey, '-inf', '+inf')
        })

        this.socket.on('connect', async ()=>{
          // always reset led on connect
          platform.ledNetworkUp();

          if (!platform.isFireRouterManaged()) {
            if (this.wanDownEventJob)
              clearTimeout(this.wanDownEventJob);
            const sysManager = require('../../net2/SysManager.js');
            const wanIntf = sysManager.getDefaultWanInterface();
            const intfName = wanIntf.name;
            const uuid = wanIntf.uuid;
            const ip4s = wanIntf.ip4_addresses;
            const wanStatus = {};
            wanStatus[intfName] = {
              "wan_intf_name": "WAN",
              "wan_intf_uuid": uuid,
              "ready": true,
              "active": true,
              "ip4s": ip4s
            };
            await era.addStateEvent("overall_wan_state", "overall_wan_state", 0, { wanStatus }).catch((err) => {
              log.error(`Failed to create overall_wan_state event`, err.message);
            });
          }

          if (this.offlineEventJob) {
            clearTimeout(this.offlineEventJob);
          }
          if (this.offlineEventFired) {
            await era.addStateEvent("box_state", "websocket", 0);
            this.offlineEventFired = false;
          }
          this.disconnectCloud = false;
          // this.lastReconnection = this.lastReconnection || Date.now() / 1000
          log.info("[Web Socket] Connecting to Firewalla Cloud: ",group.group.name, this.sioURL);
          if (this.notifyGids.length>0) {
            this.socket.emit('glisten',{'gids':this.notifyGids,'eid':this.eid,'jwt':this.token, 'name':group.group.name});
          }
        });
        group.lastfetch = Date.now() / 1000;
        group.lastMsgs = {};
        return;
      } else {
        this.socket.emit('glisten',{'gids':this.notifyGids,'eid':this.eid,'jwt':this.token});
      }
      if (key === null) {
        callback(404, null);
        return;
      } else {
        if (intervalInSeconds === 0) {
          if (group.timer) {
            clearInterval(group.timer);
            group.timer = null;
            group.lastfetch = 0;
          }
          return;
        }
        if (group.pullIntervalInSeconds > 0) {
          group.pullIntervalInSeconds = intervalInSeconds;
          group.configuredPullIntervalInSeconds = intervalInSeconds;
          if (group.timer) {
            clearInterval(group.timer);
          }
          group.timer = setInterval(group.func, group.pullIntervalInSeconds * 1000);
          callback(200, null);
          return;
        }
        group.pullIntervalInSeconds = intervalInSeconds;
        group.configuredPullIntervalInSeconds = intervalInSeconds;
        group.lastfetch = Date.now() / 1000;
        group.lastMsgs = {};
        group.lastMsgReceivedTime = 0;
        // attention is used to indicate the bot is interacting with something ... and need pull faster
        group.attention = false;
        group.func = function () {
          //log("pulling gid ",gid," time ", group.lastfetch, " interval ",group.pullIntervalInSeconds);
          self.getMsgFromGroup(gid, group.lastfetch, 100, (err, messages) => {
            //log("received messages ", messages.length);
            group.lastfetch = Date.now() / 1000 - intervalInSeconds / 2; // put a 10 second buffer
            let msgs = [];
            let msgcount = 0;
            if (err == null) {
              for (let i = 0; i < messages.length; i++) {
                if (group.lastMsgs[messages[i].id] == null) {
                  if (group.attention == false) {
                    clearInterval(group.timer);
                    group.timer = setInterval(group.func, 1 * 1000);
                    group.attention = true;
                    group.lastMsgReceivedTime = Date.now() / 1000;
                  }
                  if (messages[i].mtype == 'attn') { // no need do anything, the msg itself will trigger attention
                    continue;
                  }
                  if (messages[i].mtype == 'relax' && group.attention == true) {
                    clearInterval(group.timer);
                    group.timer = setInterval(group.func, group.configuredPullIntervalInSeconds * 1000);
                    group.attention = false;
                    continue;
                  }
                  msgcount = msgcount + 1;
                  msgs.push(messages[i]);
                  group.lastMsgs[messages[i].id] = messages[i];
                }
              }
              if (messages.length == 0) {
                group.lastMsgs = {};
              }
              if (msgcount == 0 && group.attention == true) {
                if ((Date.now() / 1000 - group.lastMsgReceivedTime) > inactivityTimeout) {
                  clearInterval(group.timer);
                  group.timer = setInterval(group.func, group.configuredPullIntervalInSeconds * 1000);
                  group.attention = false;
                }
              }
            }
            // in case things are out of wack ...
            callback(err, msgs);
          });
        };
        group.timer = setInterval(group.func, group.pullIntervalInSeconds * 1000);

      }
    });
  }

  sendHtmlToGroup(gid, _msg, beepmsg, from, callback) {
    let msg = {
      msg: _msg,
      type: 'htmlmsg',
      from: from
    };
    let beep = null;
    if (beepmsg != null) {
      beep = {
        cmd: 'apn',
        msg: beepmsg
      };
    }
    this.sendMsgToGroup(gid, msg, beep, "msg", null, null, (e, r) => {
      log.debug("sending logs ", e, r);
      if (callback) {
        callback(e);
      }
    });
  }

  sendTextToGroup2(gid, _msg, beepmsg, beepdata, from, callback) {
    let msg = {
      msg: _msg,
      type: 'msg',
      from: from
    };
    let beep = null;
    if (beepmsg != null) {
      beep = {
        cmd: 'apn',
        msg: beepmsg
      };
      if (beepdata) beep.data = beepdata
      log.info("APN notification payload: ", beep);
    }
    this.sendMsgToGroup(gid, msg, beep, "msg", null, null, (e, r) => {
      log.debug("sending logs ", e, r);
      if (callback) {
        callback(e);
      }
    });
  }

  sendDataToGroup(gid, _msg, obj, type, from, beepmsg, whisper, callback) {
    let msg = {
      msg: _msg,
      type: type,
      data: obj,
      whisper: whisper,
      from: from
    };

    let beep = null;
    if (beepmsg != null) {
      beep = {
        cmd: 'apn',
        msg: beepmsg
      };
    }
    this.sendMsgToGroup(gid, msg, beep, "msg", null, null, (e, r) => {
      log.debug("sending logs ", e, r);
      if (callback) {
        callback(e);
      }
    });
  }

  sendFileToGroup(gid, _msg, path, thumb_path, _type, from, _beepmsg, height, width, sound, callback) {
    let self = this;
    this.uploadFile(gid, thumb_path, (e, thumb_url) => {
      let mid = null;
      if (e) {
        callback(e);
      } else {
        if (thumb_url) {
          mid = thumb_url.key;
        }
        self.uploadFile(gid, path, (e2, url) => {
          if (e2 && url) {
            callback(e2);
          } else {
            let type = _type;
            if (!type) {
              type = "image";
            }
            let msg = {
              msg: _msg,
              type: type,
              from: from,
              width: width,
              height: height,
            };
            let beep = null;
            if (_beepmsg != null) {
              beep = {
                cmd: 'apn',
                msg: _beepmsg
              };
            }
            if (sound != null && beep != null) {
              beep['sound'] = sound;
            }
            self.sendMsgToGroup(gid, msg, beep, "file", url.key, mid, (e, r) => {
              log.debug("sending messages", e, r);
              callback(e, r);
            });
          }
        });
      }
    });
  }

  reKeyForEpt(skey, eid, ept) {
    let publicKey = ept.publicKey;

    log.debug("rekeying with symmetriKey", ept, " and ept ", eid);
    let symmetricKey = this.privateDecrypt(this.myPrivateKey, skey.key);
    log.info("Creating peer publicKey: ", publicKey);
    let peerPublicKey = this.nodeRSASupport
      ? crypto.createPublicKey(publicKey)
      : ursa.createPublicKey(publicKey);
    let encryptedSymmetricKey = this.publicEncrypt(peerPublicKey, symmetricKey);
    let keyforept = {
      eid: eid,
      key: encryptedSymmetricKey,
      effective: skey.effective,
      expires: skey.expires,
    }

    if (ept['name']) {
      keyforept.name = this.encrypt(ept['name'], symmetricKey);
    }


    log.info("new key created for ept ", eid, " : ", keyforept);
    return keyforept;
  }

  async syncLegacyKeyToNewKey(gid) {
    const group = this.getGroupFromCache(gid);
    if(group.key) {
      await this.reKeyForAll(gid, {key: group.key});
    }
  }

  encryptedAndSign(ts, ttl, keyToBeEncrypted, pubkey) {
    const peerPublicKey = this.nodeRSASupport
      ? crypto.createPublicKey(pubkey)
      : ursa.createPublicKey(pubkey);

    const key = this.publicEncrypt(peerPublicKey, keyToBeEncrypted);

    const signTool = crypto.createSign('RSA-SHA256');
    const signPayload = JSON.stringify({ ts, ttl, key });
    signTool.update(signPayload);
    const sign = signTool.sign(this.myprivkeyfile, 'base64');

    return {key, sign};
  }

  async reKeyForAll(gid, options = {}) {
    log.info('reKeysForAll', gid, options)
    const group = this.getGroupFromCache(gid);
    const nkey = group && group.rkey && group.rkey.nkey;

    const newKey = options.key || nkey || this.keygen();
    const nextKey = this.keygen();
    const ts = new Date() / 1;
    const ttl = options.ttl || 3600 * 24 * 7;

    const pubkeys = await this.getPublicKeys(gid);

    const rkeyPayload = {};

    for(const eid in pubkeys) {
      const pubkey = pubkeys[eid];

      const {key, sign} = this.encryptedAndSign(ts, ttl, newKey, pubkey);

      const nKeyAndSign = this.encryptedAndSign(ts, ttl, nextKey, pubkey);

      const obj = {ts, ttl, key, sign, nkey: nKeyAndSign.key, nsign: nKeyAndSign.sign};

      rkeyPayload[eid] = JSON.stringify(obj);
    }

    const rpOptions = {
      uri: `${this.endpoint}/group/rekey/${this.appId}/${gid}`,
      family: 4,
      method: 'POST',
      json: rkeyPayload,
      maxAttempts: 3
    };

    await this.rrWithEptRelogin(rpOptions);

    // force reload group information
    await this.groupFind(gid);
  }

  async getPublicKeys(gid) {
    log.info("Getting public keys for gid:", gid);

    const options = {
      uri: `${this.endpoint}/group/pubkeys/${this.appId}/${gid}`,
      family: 4,
      method: 'GET',
      json: true,
      maxAttempts: 3
    };

    const resp = await this.rrWithEptRelogin(options);

    return resp.body;
  }

  async eptInviteGroup(gid, eid) {
    log.info("eptinviteGroup:  Inviting ", eid, " to ", gid);
    const ept = await this.eptFind(eid)
    log.debug("found ept: ", ept);

    if (ept.publicKey == null) return

    const result = await this.groupFind(gid)
    if (result == null) {
      throw new Error("Failed to invite: group not found");
    }
    log.debug("finding group my eid", this.eid, " inviting ", eid, "grp", result.group);

    const peerKey = this.reKeyForEpt(result.symmetricKey, eid, ept);
    if (peerKey == null) return

    const options = {
      uri: this.endpoint + '/group/' + this.appId + "/" + result.group._id + "/" + encodeURIComponent(eid),
      family: 4,
      method: 'POST',
      json: {
        'symmetricKey': peerKey,
      },
      maxAttempts: 3
    };

    const resp = await this.rrWithEptRelogin(options)

    return resp.body
  }

  async eptinviteGroupByRid(gid, rid) {
    // log.info("inviting ", rid, " to ", gid);
    const rinfo = await this.rendezvousMap(rid)
    log.info("found rinfo", rinfo);
    return rinfo
  }


  eptGenerateInvite() {
    let k = uuid.v4();
    return {
      'r': k,
      'e': this.eid
    };
  }

  getStorage(gid, size, expires, callback) {
    let options = {
      uri: this.endpoint + '/service/message/storage/' + gid + '?size=' + size + '&expires=' + expires,
      family: 4,
      method: 'GET',
      auth: {
        bearer: this.token
      }
    };

    log.info("group find ", options);

    request(options, (err, httpResponse, body) => {
      if (err != null) {
        let stack = new Error().stack;
        log.error("Error while requesting ", err, stack);
        callback(err, null);
        return;
      }
      if (httpResponse.statusCode < 200 ||
        httpResponse.statusCode > 299) {
        this.eptHandleError(httpResponse.statusCode, (code, p) => {
          callback(httpResponse.statusCode, null);
        });
      } else {
        let bodyJson = this._parseJsonSafe(body);
        if (bodyJson != null) {
          callback(err, bodyJson);
        } else {
          callback(new Error("Malformed JSON"), null);
        }
      }
    });
  }

  _uploadFile(gid, url, filepath, callback) {
    log.info("Uploading file ", filepath, " to ", url);
    let self = this;
    this.getKey(gid, function (err, key, cacheGroup) {
      if (err != null && key == null) {
        callback(err, null);
        return;
      }
      log.info('tag is ', self.tag, 'key is ', key);
      fs.readFile(filepath, (err, data) => {
        let crypted = self.encryptBinary(data, key);
        request({
          method: 'PUT',
          url: url,
          body: crypted,
          family: 4
        },
          function (error, response, body) {
            if (response.statusCode === 200) {
              log.info("Upload done ");
              callback(null, null);
            } else {
              log.error("Upload fail ");
              callback(response.statusCode, null);
            }

          }
        );
      });
    });
  }

  uploadFile(gid, filepath, callback) {
    let self = this;
    if (filepath == null) {
      callback(null, null);
      return;
    }
    this.getStorage(gid, 1000000, 0, function (e, url) {
      if (e) {
        callback(e, null);
        return;
      }
      self._uploadFile(gid, url.url, filepath, function (e, r) {
        if (e != null) {
          callback(e, null);
          return;
        } else {
          callback(e, url);
        }
      });
    });
  }

  _parseJsonSafe(jsonData) {
    try {
      let json = JSON.parse(jsonData);
      return json;
    } catch (err) {
      log.warn("Failed to parse json: " + jsonData);
      return null;
    }
  }

};

module.exports = legoEptCloud;
