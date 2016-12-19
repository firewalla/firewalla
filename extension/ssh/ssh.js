'use strict';

var instance = null;
var log = null;

var fs = require('fs');
var util = require('util');

function getUserHome() {
  return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
}

var fileAuthorizedKeys = getUserHome() + "/.ssh/authorized_keys";
var fileRSAKey = getUserHome() + "/.ssh/id_rsa.firewalla";
var fileRSAPubKey = getUserHome() + "/.ssh/id_rsa.firewalla.pub";
var RSAComment = "firewalla";



module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            log = require("../../net2/logger.js")("ssh manager", loglevel);

            instance = this;
        }
        return instance;
    }

    getPrivateKey(callback) {
      fs.readFile(fileRSAKey, function(err, data) {
        if(err) throw err;

        callback(err, data.toString('utf8'));
      });
    }

    keyExists() {
      return fs.existsSync(fileRSAKey) && fs.existsSync(fileRSAPubKey);
    }

    removeRSAKeyPair() {
      fs.existsSync(fileRSAKey) && fs.unlinkSync(fileRSAKey);
      fs.existsSync(fileRSAPubKey) && fs.unlinkSync(fileRSAPubKey);
    }

    resetPassword(callback) {
      this.generateRSAPair((err) => {

        if(err) {
          callback(err);
          return;
        }

        this.removePreviousKeyFromAuthorizedKeys((err) => {
          if(err) {
            callback(err);
            return;
          }

          this.appendAuthorizedKeys((err) => {
            callback(err);
          })
        })
        
      });
    }

    generateRSAPair(callback) {
      let keygenCmd = util.format('/bin/bash -c \'/bin/echo "y\n" | ssh-keygen -q -t rsa -f ~/.ssh/id_rsa.firewalla -C "%s" -N "" \'', RSAComment);
      require('child_process').exec(keygenCmd, { timeout: 3000 }, (err, out, code) => {
        if(err) {
          console.log(err);
          console.log(out);
          log.error("SSH:generateRSAPair:Error", "unable to create RSA pair for login");
        }
        callback(err);
      });
    }

    removePreviousKeyFromAuthorizedKeys(callback) {
      let removeCmd = util.format('/bin/bash -c \'touch %s; sed -i "/ %s$/d" %s\'', fileAuthorizedKeys, RSAComment, fileAuthorizedKeys);
      require('child_process').exec(removeCmd, (err, out, code) => {
        if(err) {
          log.error("SSH:removePreviousKeyFromAuthorizedKeys:Error", "Unable to remove previous key from authorized_keys");
        }
        callback(err);
      });
    }

    appendAuthorizedKeys(callback) {
      let appendCmd = util.format('cat %s.pub >> %s', fileRSAKey, fileAuthorizedKeys);
      require('child_process').exec(appendCmd, (err, out, code) => {
        if(err) {
          log.error("SSH:appendAuthorizedKeys:Error", "Unable to append new key to authorized_keys");
        }
        callback(err);
      });
    }
}
