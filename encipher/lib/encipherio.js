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

let ursa = require('ursa');
let crypto = require('crypto');
let fs = require('fs');
let path = require('path');
let request = require('requestretry');
let uuid = require("uuid");
let io2 = require('socket.io-client');

let log = require('../../net2/logger')(__filename);

let Promise = require('bluebird');
Promise.promisifyAll(fs);

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let zlib = require('zlib');
let License = require('../../util/license.js');

let debugging = false;

let fConfig = require('../../net2/config.js').getConfig();

let exec = require('child-process-promise').exec;


let instance = {};

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

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
            this.privpem = null;
            this.pubpem = null;
            this.publicKeyStore = {};
            this.appId = null;
            this.aid = null; // aid is the system wide unique application id (UID of application)
            this.appSecret = null;
            this.info = null; // to be encrypted
            this.signature = "";
            this.endpoint = fConfig.firewallaGroupServerURL || "https://firewalla.encipher.io/iot/api/v2";
            this.token = null;
            this.eid = null;
            this.groupCache = {};
            this.cryptoalgorithem = 'aes-256-cbc';
            this.name = name;
            this.errTtl = 2; // only retry x times for bad requests
            debugging = false;
            this.notifySocket = false;
            this.notifyGids = [];

        }
        // NO LONGER create keypair in sync node during constructor

        // if (true == this.keypair(name, pathname)) {
        //     return instance[name];
        // } else {
        //     log.info("ENCIPHER.IO Failed to create keys");
        //     instance[name] = null;
        //     return null;
        // }
    }

    keyReady() {
      log.info("Checking whether key pair exists already");

      return async(() => {

        try {
          await(fs.accessAsync(this.getPublicKeyPath()));
          await(fs.accessAsync(this.getPrivateKeyPath()));
        } catch(err) {
          if(err) {
            return Promise.resolve(null);
          }
        }

        let pubFile = await(fs.readFileAsync(this.getPublicKeyPath()));
        let priFile = await(fs.readFileAsync(this.getPrivateKeyPath()));
        if(pubFile.length < 10 || priFile.length < 10) {
          log.error("ENCIPHER.IO Unable to read keys, keylength error", pubFile.length, priFile.length);
          await(this.cleanupKeys());
          return Promise.resolve(null);
        } else {
          log.info("Key pair exists");
          return Promise.resolve({pub: pubFile, pri: priFile});
        }

      })();
    }

    utilKeyReady() {
      return async(() => {
        let result = await(this.keyReady());
        if(!result) {
          log.info("Checking if keys are ready...");
          await(delay(3000)); // wait for three seconds
          return await(this.utilKeyReady());
        }
        return true;
      })();
    }

    cleanupKeys() {
      log.info("Cleaning up key pairs");

      this.myprivkeyfile = null;
      this.mypubkeyfile = null;
      this.myPublicKey = null;
      this.myPrivateKey = null;

      return async(() => {
        await(exec("sudo rm -f "+pathname+"/db/groupId"));
        await(exec("sync"));
        return Promise.resolve();
      })();
    }

    getPrivateKeyPath() {
      return this.keyPath + this.name + ".privkey.pem";
    }

    getPublicKeyPath() {
      return this.keyPath + this.name + ".pubkey.pem";
    }

    loadKeys() {
      log.info("Loading or creating keys");
      return async(() => {
        if(this.myPublicKey && this.myPrivateKey) {
          return Promise.resolve();
        }
        if(this.myprivkeyfile && this.mypubkeyfile) {
          this.myPublicKey = ursa.createPublicKey(this.mypubkeyfile);
          this.myPrivateKey = ursa.createPrivateKey(this.myprivkeyfile);
          return Promise.resolve();
        }

        let keys = await(this.keyReady());
        if(keys) {
          this.mypubkeyfile = keys.pub;
          this.myprivkeyfile = keys.pri;
          this.myPublicKey = ursa.createPublicKey(this.mypubkeyfile);
          this.myPrivateKey = ursa.createPrivateKey(this.myprivkeyfile);
          return Promise.resolve();
        } else {
          return this.createKeyPair();
        }
      })();
    }

    createKeyPair() {
      let key = ursa.generatePrivateKey(2048, 65537);
      let privateKeyPem = key.toPrivatePem();
      let pubKeyPem = key.toPublicPem();

      return async(() => {

        await(fs.writeFileSync(this.getPrivateKeyPath(), privateKeyPem, 'ascii'));
        await(fs.writeFileSync(this.getPublicKeyPath(), pubKeyPem, 'ascii'));
        await(exec("sync"));

        this.myPublicKey = ursa.createPublicKey(pubKeyPem);
        this.myPrivateKey = ursa.createPrivateKey(privateKeyPem);
      })();
    }

    debug(state) {
        debugging = state;
    }

    keypair(name, pathname) {
        log.info("Reading pem from ", pathname + name + ".privkey.pem");
        if (fs.existsSync(pathname + name + ".privkey.pem") && fs.existsSync(pathname + name + ".pubkey.pem")) {
            try {
                this.myprivkeyfile = fs.readFileSync(pathname + name + ".privkey.pem");
                this.mypubkeyfile = fs.readFileSync(pathname + name + ".pubkey.pem");
                if (this.myprivkeyfile.length<10 || this.mypubkeyfile.length<10) {
                    log.info("ENCIPHER.IO Unable to read keys, keylength error", this.myprivkeyfile.length, this.mypubkeyfile.length);
                    this.myprivkeyfile = null;
                    this.mypubkeyfile = null;
                    require('child_process').execSync("sudo rm -f "+pathname+"/db/groupId");
                    require('child_process').execSync("sync");
                }
            } catch (err) {
                log.info("ENCIPHER.IO Unable to read keys");
                return false;
            }
        }
        if (this.myprivkeyfile == null || this.mypubkeyfile == null) {
            let key = ursa.generatePrivateKey(2048, 65537);
            let privateKeyPem = key.toPrivatePem();
            let pubKeyPem = key.toPublicPem();

            try {
                fs.writeFileSync(path.join(pathname, name + ".privkey.pem"), privateKeyPem, 'ascii');
                fs.writeFileSync(path.join(pathname, name + ".pubkey.pem"), pubKeyPem, 'ascii');
                require('child_process').execSync("sync");
            } catch (err) {
                log.info("ENCIPHER.IO Unable to write keys");
                return false;
            }

            this.myPublicKey = ursa.createPublicKey(pubKeyPem);
            this.myPrivateKey = ursa.createPrivateKey(privateKeyPem);
        } else {
            this.myPublicKey = ursa.createPublicKey(this.mypubkeyfile);
            this.myPrivateKey = ursa.createPrivateKey(this.myprivkeyfile);
        }
        return true;
    }

    addPeer(publicKey, pid) {
        if (this.publicKeyStore(pid)) {

        }
    }


    // Info is not encrypted
    eptlogin(appId, appSecret, eptInfo, tag, callback) {
        this.appId = appId;
        this.appSecret = appSecret;
        this.eptInfo = eptInfo;
        this.tag = tag;
        this.info = eptInfo;
        let assertion = {
            'assertion': {
                'name': this.tag,
                'publicKey': this.myPublicKey.toPublicPem('utf8'),
                'appId': this.appId,
                'appSecret': this.appSecret,
                'signature': this.signature,
                'license': License.getLicense()
            }
        };
        if (this.info) {
            assertion.assertion.info = this.info;
        }

        //log("Assertion"+JSON.stringify(assertion));
        let options = {
            uri: this.endpoint + '/login/eptoken',
            family: 4,
            method: 'POST',

            json: assertion
        };

        let self = this;
        request(options, (err, httpResponse, body) => {
            if (err != null) {
                let stack = new Error().stack;
                log.info("Error while requesting ", err, stack);
                callback(err, null);
                return;
            }
            if (httpResponse == null) {
                callback(500, null);
                return;
            }
            if (httpResponse.statusCode < 200 ||
                httpResponse.statusCode > 299) {
                callback(httpResponse.statusCode, null);
                return;
            }
            //  log.info(body.access_token);
            if (err === null) {
                self.token = body.access_token;
                self.eid = body.eid;
                self.groups = body.groups;
                self.aid = body.aid;
//                log.info("------------------------------------");
                //log(JSON.stringify(self.groups));
            }
            callback(err, self.eid);
        });
    }

    eptRelogin(callback) {
        this.eptlogin(this.appId, this.appSecret, this.eptInfo, this.tag, (err, eid) => {
            callback(err, eid);
        });
    }

    eptHandleError(code, callback) {
        if (code == '401' || code == 401) {
            this.eptRelogin((err, eid) => {
                if (err == null) {
                    if (callback) {
                        callback(202, null);
                    }
                } else {
                    if (callback) {
                        callback(code, null);
                    }
                }
            });
        } else {
            if (callback) {
                callback(code, null);
            }
        }
    }

    eptcreateGroup(name, info, alias, callback) {
        let symmetricKey = this.keygen();
        let group = {};
        let encryptedSymmetricKey = this.myPublicKey.encrypt(symmetricKey, 'utf8', 'base64');

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
            auth: {
                bearer: this.token
            },
            json: group
        };

        request(options, (err, httpResponse, body) => {
            log.debug("created group ", body);
            log.debug(body);
            if (err != null) {
                let stack = new Error().stack;
                log.info("Error while requesting ", err, stack);
                callback(err, null);
                return;
            }
            if (httpResponse.statusCode < 200 ||
                httpResponse.statusCode > 299) {
                this.eptHandleError(httpResponse.statusCode, (code, p) => {
                    callback(httpResponse.statusCode, null);
                });
            } else {
                if (body && body.gid) {
                    callback(null, body.gid);
                } else {
                    callback(null, null);
                }
            }
        });

    }

    eptFind(eid, callback) {
        let options = {
            uri: this.endpoint + '/ept/' + encodeURIComponent(eid),
            family: 4,
            method: 'GET',
            auth: {
                bearer: this.token
            }
        };

        request(options, (err, httpResponse, body) => {
            if (err != null) {
                let stack = new Error().stack;
                log.info("Error while requesting ", err, stack);
                callback(err, null);
                return;
            }
            if (httpResponse.statusCode < 200 ||
                httpResponse.statusCode > 299) {
                this.eptHandleError(httpResponse.statusCode, (code, p) => {
                    callback(httpResponse.statusCode, null);
                });
            } else {
                if (body !== null && body !== undefined) {
                    callback(err, JSON.parse(body));
                } else {
                    callback(err, null);
                }
            }
        });
    }

    eptGroupList(eid, callback) {
        let options = {
            uri: this.endpoint + '/ept/' + encodeURIComponent(eid) + '/groups',
            family: 4,
            method: 'GET',
            auth: {
                bearer: this.token
            }
        };

        log.debug("Group search ", options.uri);
        let self = this;

        request(options, function (err, httpResponse, body) {
            if (err != null) {
                let stack = new Error().stack;
                log.error("Error while requesting ", err, stack);
                callback(err, null);
                return;
            }
            if (httpResponse.statusCode < 200 ||
                httpResponse.statusCode > 299) {
                callback(httpResponse.statusCode, null);
            } else {
                if (body !== null && body !== undefined) {
                    let groups = JSON.parse(body);
                    for (let i = 0; i < groups['groups'].length; i++) {
                        let group = groups['groups'][i];
                        group.gid = group._id;
                        if (group["xname"]) {
                            let gg = self.parseGroup(group);
                            if (gg && gg.key) {
                                group['name'] = self.decrypt(group['xname'], gg.key);
                            }
                        }
                    }
                    callback(err, groups.groups); // "groups":groups
                } else {
                    callback(err, null);
                }
            }
        });
    }


   rendezvousMap (rid, callback) {
        let options = {
            uri: this.endpoint + '/ept/rendezvous/' + rid,
            family: 4,
            method: 'GET',
            auth: {
                bearer: this.token
            }
        };

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
                callback(err, JSON.parse(body)); ///{value:xxx}
            }
        });
    }


    groupFind(gid, callback) {

        if (this.appId === undefined || gid === undefined) {
            callback("parameter error", null);
            return;
        }
        let options = {
            uri: this.endpoint + '/group/' + this.appId + "/" + gid,
            family: 4,
            method: 'GET',
            auth: {
                bearer: this.token
            }
        };

        log.debug("group find ", options);

        let self = this;

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
                if(body.length == 0) {
                    callback("invalid group id", null);
                    return;
                }
                let b = null;
                try {
                    b = JSON.parse(body);
                    self.groupCache[gid] = self.parseGroup(b);
                    callback(err, b);
                } catch (e) {
                    callback(e, null);
                }
            }
        });
    }

    parseGroup(group) {
        if (group == null) {
            return null;
        }

        let sk = null;
        let kcache = {};
        for (let k in group.symmetricKeys) {
            let skey = group.symmetricKeys[k];
            if (skey.eid === this.eid) {
                sk = skey;
                break;
            }
        }
        if (sk === null) {
            return null;
        } else {
            let symmetricKey = this.myPrivateKey.decrypt(sk.key, 'base64', 'utf8');
            this.groupCache[group._id] = {
                'group': group,
                'symanttricKey': sk,
                'key': symmetricKey,
                'lastfetch': 0,
                'pullIntervalInSeconds': 0,
            };
            for (let k in group.symmetricKeys) {
                let skey = group.symmetricKeys[k];
                if (skey.name) {
                    skey.displayName = this.decrypt(skey.name, symmetricKey);
                } else if (skey.uid) {
                    skey.displayName = skey.uid;
                }
                if (skey.eid == this.eid) {
                    group.me = skey;
                }
            }

            return this.groupCache[group._id];
        }
    }

    getKey(gid, callback) {
        let g = this.groupCache[gid];
        if (g) { // and check valid later
            //log('cache hit', gid);
            callback(null, g.key, g);
            return g.key;
        }

        let self = this;

        this.groupFind(gid, function (err, group) {
            if (err == null && group != null) {
                self.groupCache[gid] = self.parseGroup(group);
                if (self.groupCache[gid]) {
                    callback(null, self.groupCache[gid]['key'], self.groupCache[gid]);
                } else {
                    callback(null, null, null);
                }
            } else {
                callback(err, null, null);
            }

            /*
            let sk = null;
            let kcache = {};
            for (let k in group.symmetricKeys) {
                let skey = group.symmetricKeys[k];
                if (skey.eid === self.eid) {
                   sk = skey;
                   break;
                }
            }
            if (sk === null) {
                callback(null, null,null);
            } else {
                let symmetricKey = self.myPrivateKey.decrypt(sk.key,'base64','utf8');
                self.groupCache[gid] = {
                  'group': group,
                  'symanttricKey':sk,
                  'key': symmetricKey,
                  'lastfetch': 0,
                  'pullIntervalInSeconds':0,
                };
                callback(null, symmetricKey,self.groupCache[gid]);
            }
            */

        });
        return null;
    }

    encrypt(text, key) {
        let iv = new Buffer(16);
        iv.fill(0);
        let bkey = new Buffer(key.substring(0, 32), "utf8");
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
        let iv = new Buffer(16);
        iv.fill(0);
        let bkey = new Buffer(key.substring(0, 32), "utf8");
        let cipher = crypto.createCipheriv(this.cryptoalgorithem, bkey, iv);
        let crypted = cipher.update(data);

        crypted = Buffer.concat([crypted, cipher.final()]);
        log.debug('encryted data with size', crypted.length, crypted.constructor.name);
        return crypted;
    }

    decrypt(text, key) {
        let iv = new Buffer(16);
        iv.fill(0);
        let bkey = new Buffer(key.substring(0, 32), "utf8");
        let decipher = crypto.createDecipheriv(this.cryptoalgorithem, bkey, iv);
        let dec = decipher.update(text, 'base64', 'utf8');
        dec += decipher.final('utf8');
        return dec;
    }

    keygen() {
        let k = uuid.v4();
        return k.replace('-', '');
    }

    // This is to encrypt message for direct communication between app and pi.
    // The message will not be transferred via cloud
    // just encrypt and send via callback
    encryptMessage(gid, msg, callback) {
        this.getKey(gid, (err, key, cacheGroup) => {
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

    log.info("encipher unencrypted message size: ", msgstr.length, "ttl:", ttl, {});

    this.getKey(gid, (err, key, cacheGroup) => {
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
      let options = {
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
    });
  }

  sendMsgToGroup(gid, msg, _beep, mtype, fid, mid, callback) {
    log.debug(msg, {});
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
      let input = new Buffer(msgstr, 'utf8');
      zlib.deflate(input, (err, output) => {
        if(err) {
          log.error("Failed to compress payload:", err, {});
          callback(err);
          return;
        }

        let payload = {
          compressMode: true,
          data: output.toString('base64')
        };
        
        this._send(gid, JSON.stringify(payload), _beep, mtype, fid, mid, 5, callback)
      })
    } else {
      this._send(gid, msgstr, _beep, mtype, fid, mid, 5, callback)
    }

  }

    // Direct one-to-one message handling
    receiveMessage(gid, msg, callback) {
        let logMessage = require('util').format("Got encrypted message from group %s", gid);
      log.debug(logMessage);

        this.getKey(gid, (err, key, cacheGroup) => {
          if (err != null && key == null) {
            log.error("Got error when fetching key: %s", key);
            callback(err, null);
            return;
          }

          if(key == null) {
            log.error("encryption key is not found for group: %s", gid);
            callback("key not found, invalid group?", null);
            return;
          }

          let decryptedMsg = this.decrypt(msg, key);
          let msgJson = JSON.parse(decryptedMsg);
          callback(null, msgJson);
        });
    }

    getMsgFromGroup(gid, timestamp, count, callback) {
        let self = this;
        this.getKey(gid, (err, key, cacheGroup) => {
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

                let data = JSON.parse(body).data;
                let messages = [];
                for (let m in data) {
                    let obj = data[m];
                    if (self.eid === obj.fromUid) {
                        continue;
                    }
                    let message = JSON.parse(self.decrypt(obj.message, key));
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
                callback(err, messages, cacheGroup);
            });

        });
    }


    // This will pull messags from now ...
    //
    // if 0 is passed in intervalInSeconds, pulling will stop

    pullMsgFromGroup(gid, intervalInSeconds, callback,boneCallback) {
        let self = this;
        let inactivityTimeout = 5 * 60; //5 min
        this.getKey(gid, (err, key, cacheGroup) => {
            if (this.socket == null) {
                this.notifyGids.push(gid);
                this.socket = io2('https://firewalla.encipher.io',{path: '/socket',transports:['websocket'],'upgrade':false});
                this.socket.on('disconnect', ()=>{
                    this.notifySocket = false;
                });
                this.socket.on("glisten200",(data)=>{
                     log.forceInfo("SOCKET Glisten 200 group indicator");
                });
                this.socket.on("newMsg",(data)=>{
                     self.getMsgFromGroup(gid, data.ts, 100, (err, messages, cacheGroup2) => {
                         cacheGroup.lastfetch = Date.now() / 1000;
                         callback(err,messages);
                     });
                });
                this.socket.on("boneMsg",(data)=> {
                     console.log("SOCKET boneMsg ");
                     if (boneCallback && data) {
                         boneCallback(null,data);
                     }
                });
                this.socket.on('connect', ()=>{
                    this.notifySocket = true;
                    log.info("[Web Socket] Connecting to Firewalla Cloud: ",cacheGroup.group.name);
                    if (this.notifyGids.length>0) {
                        this.socket.emit('glisten',{'gids':this.notifyGids,'eid':this.eid,'jwt':this.token, 'name':cacheGroup.group.name});
                    }
                });
                cacheGroup.lastfetch = Date.now() / 1000;
                cacheGroup.lastMsgs = {};
                return;
            } else {
                this.socket.emit('glisten',{'gids':this.notifyGids,'eid':this.eid,'jwt':this.token});
            }
            if (key === null) {
                callback(404, null);
                return;
            } else {
                if (intervalInSeconds === 0) {
                    if (cacheGroup.timer) {
                        clearInterval(cacheGroup.timer);
                        cacheGroup.timer = null;
                        cacheGroup.lastfetch = 0;
                    }
                    return;
                }
                if (cacheGroup.pullIntervalInSeconds > 0) {
                    cacheGroup.pullIntervalInSeconds = intervalInSeconds;
                    cacheGroup.configuredPullIntervalInSeconds = intervalInSeconds;
                    if (cacheGroup.timer) {
                        clearInterval(cacheGroup.timer);
                    }
                    cacheGroup.timer = setInterval(cacheGroup.func, cacheGroup.pullIntervalInSeconds * 1000);
                    callback(200, null);
                    return;
                }
                cacheGroup.pullIntervalInSeconds = intervalInSeconds;
                cacheGroup.configuredPullIntervalInSeconds = intervalInSeconds;
                cacheGroup.lastfetch = Date.now() / 1000;
                cacheGroup.lastMsgs = {};
                cacheGroup.lastMsgReceivedTime = 0;
                // attention is used to indicate the bot is interacting with something ... and need pull faster
                cacheGroup.attention = false;
                cacheGroup.func = function () {
                    //log("pulling gid ",gid," time ", cacheGroup.lastfetch, " interval ",cacheGroup.pullIntervalInSeconds);
                    self.getMsgFromGroup(gid, cacheGroup.lastfetch, 100, (err, messages, cacheGroup2) => {
                        //log("received messages ", messages.length);
                        cacheGroup.lastfetch = Date.now() / 1000 - intervalInSeconds / 2; // put a 10 second buffer
                        let msgs = [];
                        let msgcount = 0;
                        if (err == null) {
                            for (let i = 0; i < messages.length; i++) {
                                if (cacheGroup.lastMsgs[messages[i].id] != null) {} else {
                                    if (cacheGroup.attention == false) {
                                        clearInterval(cacheGroup.timer);
                                        cacheGroup.timer = setInterval(cacheGroup.func, 1 * 1000);
                                        cacheGroup.attention = true;
                                        cacheGroup.lastMsgReceivedTime = Date.now() / 1000;
                                    }
                                    if (messages[i].mtype == 'attn') { // no need do anything, the msg itself will trigger attention
                                        continue;
                                    }
                                    if (messages[i].mtype == 'relax' && cacheGroup.attention == true) {
                                        clearInterval(cacheGroup.timer);
                                        cacheGroup.timer = setInterval(cacheGroup.func, cacheGroup.configuredPullIntervalInSeconds * 1000);
                                        cacheGroup.attention = false;
                                        continue;
                                    }
                                    msgcount = msgcount + 1;
                                    msgs.push(messages[i]);
                                    cacheGroup.lastMsgs[messages[i].id] = messages[i];
                                }
                            }
                            if (messages.length == 0) {
                                cacheGroup.lastMsgs = {};
                            }
                            if (msgcount == 0 && cacheGroup.attention == true) {
                                if ((Date.now() / 1000 - cacheGroup.lastMsgReceivedTime) > inactivityTimeout) {
                                    clearInterval(cacheGroup.timer);
                                    cacheGroup.timer = setInterval(cacheGroup.func, cacheGroup.configuredPullIntervalInSeconds * 1000);
                                    cacheGroup.attention = false;
                                }
                            }
                        }
                        // in case things are out of wack ...
                        callback(err, msgs);
                    });
                };
                cacheGroup.timer = setInterval(cacheGroup.func, cacheGroup.pullIntervalInSeconds * 1000);

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

    sendTextToGroup(gid, _msg, beepmsg, from, callback) {
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
        }
        this.sendMsgToGroup(gid, msg, beep, "msg", null, null, (e, r) => {
            log.debug("sending logs ", e, r);
            if (callback) {
                callback(e);
            }
        });
    }

    sendTextToGroup2(gid, _msg, beepmsg, beepdata,from, callback) {
        let msg = {
            msg: _msg,
            type: 'msg',
            from: from
        };
        let beep = null;
        if (beepmsg != null) {
            beep = {
                cmd: 'apn',
                msg: beepmsg,
                data: beepdata
            };
          log.info("APN notification payload: ", beep, {});
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
        let symmetricKey = this.myPrivateKey.decrypt(skey.key, 'base64', 'utf8');
        log.info("Creating peer publicKey: ", publicKey);
        let peerPublicKey = ursa.createPublicKey(publicKey);
        let encryptedSymmetricKey = peerPublicKey.encrypt(symmetricKey, 'utf8', 'base64');
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

    eptinviteGroupAsync(gid, eid) {
      return new Promise((resolve, reject) => {
        this.eptinviteGroup(gid, eid, (err, result) => {
          if(err)
            reject(err)
          else
            resolve(result);
        })
      })
    }

    eptinviteGroup(gid, eid, callback) {
        log.info("eptinviteGroup:  Inviting ", eid, " to ", gid);
        let self = this;
        this.eptFind(eid, function (err, ept) {
            if (ept) {
                log.debug("found ept: ", ept);
                if (ept.publicKey !== null) {
                    self.groupFind(gid, function (err, grp) {
                        log.debug("finding group my eid", self.eid, " inviting ", eid, "grp", grp);
                        if (grp !== null) {
                            let mykey = null;
                            for (let key in grp.symmetricKeys) {
                                let sym = grp.symmetricKeys[key];
                                log.debug("searching keys ", key, " sym ", sym);
                                if (sym.eid === self.eid) {
                                    log.debug("found my key ", self.eid);
                                    mykey = sym;
                                }
                            }
                            if (mykey == null) {
                                callback("404", null);
                            } else {
                                let peerKey = self.reKeyForEpt(mykey, eid, ept);
                                if (peerKey != null) {
                                    let options = {
                                        uri: self.endpoint + '/group/' + self.appId + "/" + grp._id + "/" + encodeURIComponent(eid),
                                        family: 4,
                                        method: 'POST',
                                        auth: {
                                            bearer: self.token
                                        },
                                        json: {
                                            'symmetricKey': peerKey,
                                        }
                                    };
                                    request(options, function (err, httpResponse, body) {
                                        callback(err, body);
                                    });
                                }
                            }

                        } else {
                            log.error("Not able to find group");
                            callback(err, null);
                        }
                    });
                }
            } else {
                callback(err, null);
            }
        });
    }

    eptinviteGroupByRidAsync(gid, rid) {
      return new Promise((resolve, reject) => {
        this.eptinviteGroupByRid(gid, rid, (err, result) => {
          if(err)
            reject(err)
          else
            resolve(result)
        })
      });
    }

    eptinviteGroupByRid(gid, rid, callback) {
        // log.info("inviting ", rid, " to ", gid);
        let self = this;
        this.rendezvousMap(rid, function (err, rinfo) {
            if (err !== null || rinfo === null) {
                // log.error("Error not able to find rinfo");
                callback(err, null);
                return;
            }
            log.info("found rinfo", rinfo, {});
            callback(null, rinfo);
        });
    }


    eptGenerateInvite(gid) {
        let k = uuid.v4();
        //return {'r':k,'e':this.myPrivateKey.hashAndSign('sha256',k,'utf8','base64')};
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
                callback(err, JSON.parse(body));
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

};

module.exports = legoEptCloud;
