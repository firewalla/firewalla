/*    Copyright 2019 Firewalla INC
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

var instance = null;
const log = require('../../net2/logger.js')(__filename);

var fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
var util = require('util');
const cp = require('child_process');
var key = require('../common/key.js');

let f = require('../../net2/Firewalla.js');

var fileAuthorizedKeys = f.getUserHome() + "/.ssh/authorized_keys";
var fileRSAKey = f.getUserHome() + "/.ssh/id_rsa.firewalla";
var fileRSAPubKey = f.getUserHome() + "/.ssh/id_rsa.firewalla.pub";
var RSAComment = "firewalla";

const platform = require('../../platform/PlatformLoader.js').getPlatform();

const execAsync = util.promisify(cp.exec);
const readFileAsync = util.promisify(fs.readFile);

module.exports = class {
  constructor() {
    if (instance == null) {
      instance = this;
      if (f.isApi()) {
        const path = platform.getSSHPasswdFilePath();
        fs.watchFile(path, { interval: 2000 }, (curr, prev) => {
          if (curr.mtime !== prev.mtime) {
            setTimeout(() => {
              // add timeout to avoid consistency issue if password file is modified by another process
              this.loadPassword().catch((err) => {
                log.error("Failed to load ssh password", err.message);
              });
            }, 2000);
          }
        });
      }
    }
    return instance;
  }

  async savePassword(password, timestamp) {
    const obj = {
      timestamp
    };
    const path = platform.getSSHPasswdFilePath();
    await fs.writeFileAsync(path, JSON.stringify(obj), {encoding: 'utf8'});
  }

  async loadPassword() {
    const path = platform.getSSHPasswdFilePath();
    const obj = await fs.readFileAsync(path, {encoding: 'utf8'}).then(content => JSON.parse(content)).catch((err) => null);
    if (obj) {
      obj.timestamp = obj.timestamp && new Date(obj.timestamp).getTime(); // support both string and epoch format in file content and convert it to epoch
      if (!obj.timestamp || obj.timestamp !== this._timestamp) {
        log.info(`Timestamp of SSH passwd is updated, invalidate previous password ...`);
        this._password = null;
      }
      if (this._password)
        obj.password = this._password;
      return obj;
    } else {
      return {};
    }
  }

  async resetRandomPassword() {
    const password = key.randomPassword(10);
    return new Promise((resolve, reject) => {
      const spawn = require('child_process').spawn;
      const passwd = spawn('sudo', ['passwd', process.env.USER]);

      let success = false;

      passwd.stdout.on('data', (data) => {
        success = false;
      });

      passwd.stderr.on('data', (data) => {
        switch(data.toString('utf8')) {
          case "Enter new UNIX password: ":
          case "Retype new UNIX password: ":
          case "New password: ": // Navy
          case "Retype new password: ": // Navy
            passwd.stdin.write(password+"\n");
            break;
          case "passwd: password updated successfully\n":
            success = true;
            passwd.stdin.end();
            break;
          default:
            success = false;
            passwd.stdin.end();
        }
      });

      passwd.on('close', (code) => {
        if(success && code === 0) {
          const timestamp = Date.now();
          this.savePassword(password, timestamp).then(() => {
            this._password = password;
            this._timestamp = timestamp;
            const obj = {password, timestamp};
            resolve(obj);
          }).catch((err) => {
            reject(err);
          });
        } else {
          reject(new Error("Failed to generate new password"));
        }
      });

      passwd.on('error', (err) => {
        reject(new Error('Failed to start passwd process:' + err));
      });
    });
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

    resetRSAPassword(callback) {
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
          log.error(err);
          log.error(out);
          log.error("SSH:generateRSAPair:Error", "unable to create RSA pair for login");
        }
        callback(err);
      });
    }

    async generateRSAKeyPair(identity) {
      identity = identity || "id_rsa_firewalla";
      const cmd = util.format('/bin/bash -c \'/bin/echo "y\n" | ssh-keygen -q -t rsa -f ~/.ssh/%s -N "" -C "%s"\'', identity, identity);
      await execAsync(cmd);
    }

    async getRSAPublicKey(identity) {
      identity = identity || "id_rsa_firewalla";
      const filename = util.format("%s/.ssh/%s.pub", f.getUserHome(), identity);
      if (fs.existsSync(filename)) {
        const pubKey = await readFileAsync(filename, 'utf8');
        return pubKey;
      } else return null;      
    }

    async getRSAPEMPublicKey(identity) {
      identity = identity || "id_rsa_firewalla";
      const filename = util.format("%s/.ssh/%s.pub", f.getUserHome(), identity);
      if (fs.existsSync(filename)) {
        const cmd = util.format("ssh-keygen -f %s -e -m PKCS8", filename);
        const result = await execAsync(cmd);
        if (result.stderr) {
          throw result.stderr;
        }
        return result.stdout;
      } else return null;
    }

    async getRSAPEMPrivateKey(identity) {
      identity = identity || "id_rsa_firewalla";
      const filename = util.format("%s/.ssh/%s", f.getUserHome(), identity);
      if (fs.existsSync(filename)) {
        const content = await readFileAsync(filename);
        return content;
      } else return null;
    }

    async saveRSAPublicKey(content, identity) {
      const filename = identity || "id_rsa_firewalla";
      let cmd = util.format("echo -n '%s' > ~/.ssh/%s.pub && chmod 600 ~/.ssh/%s.pub", content, filename, filename);
      await execAsync(cmd);
      cmd = util.format("echo -n '%s' >> ~/.ssh/authorized_keys && chmod 644 ~/.ssh/authorized_keys", content);
      await execAsync(cmd);
    }

    async saveRSAPrivateKey(content, identity) {
      const filename = identity || "id_rsa_firewalla";
      const cmd = util.format("echo -n '%s' > ~/.ssh/%s && chmod 600 ~/.ssh/%s", content, filename, filename);
      await execAsync(cmd);
    }

    async remoteCommand(host, command, username, identity) {
      username = username || "pi";
      identity = identity || "id_rsa_firewalla";
      const identity_file = util.format("~/.ssh/%s", identity);
      const cmd = util.format("ssh -o StrictHostKeyChecking=no -i %s %s@%s '%s'", identity_file, username, host, command);
      await execAsync(cmd);
    }

    async scpFile(host, sourcePath, destPath, recursive, identity, username) {
      username = username || "pi";
      identity = identity || "id_rsa_firewalla";
      const identity_file = util.format("~/.ssh/%s", identity);
      var extraOpts = "";
      if (recursive) {
        extraOpts = "-r"
      }
      const cmd = util.format("scp -o StrictHostKeyChecking=no -i %s %s %s %s@%s:%s", identity_file, extraOpts, sourcePath, username, host, destPath);
      await execAsync(cmd);
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
