'use strict';

var instance = null;
var log = null;

var fs = require('fs');
var util = require('util');
const cp = require('child_process');
var key = require('../common/key.js');
var jsonfile = require('jsonfile');

let f = require('../../net2/Firewalla.js');

var fileAuthorizedKeys = f.getUserHome() + "/.ssh/authorized_keys";
var fileRSAKey = f.getUserHome() + "/.ssh/id_rsa.firewalla";
var fileRSAPubKey = f.getUserHome() + "/.ssh/id_rsa.firewalla.pub";
var RSAComment = "firewalla";
var tempSSHPasswordLocation = f.getHiddenFolder() + "/.sshpasswd"

const execAsync = util.promisify(cp.exec);
const readFileAsync = util.promisify(fs.readFile);

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

    storePassword(password, callback) {
      var json = {
        password: password,
        timestamp: new Date()
      };

      jsonfile.writeFile(tempSSHPasswordLocation, json, {spaces: 2}, (err)=>{
          callback(err,password);
      });
    }

  getPassword(callback) {
    jsonfile.readFile(tempSSHPasswordLocation, (err, obj) => {
      if(err) {
        if(err.code === 'ENOENT') {
          callback(null, 'firewalla')
        } else {
          callback(err);
        }
      } else {
        callback(null, obj.password);
      }
    });
  }

  resetRandomPasswordAsync() {
    return new Promise((resolve, reject) => {
      this.resetRandomPassword((err, data) => {
        if(err) {
          reject(err)
        } else {
          resolve(data)
        }
      })
    })
  }
  
    resetRandomPassword(callback) {
      var newPassword = key.randomPassword(10);

      const spawn = require('child_process').spawn;
      const passwd = spawn('sudo', ['passwd', process.env.USER]);

      var success = false;

      passwd.stdout.on('data', (data) => {
        success = false;
      });

      passwd.stderr.on('data', (data) => {
        switch(data.toString('utf8')) {
          case "Enter new UNIX password: ":
          case "Retype new UNIX password: ":
            passwd.stdin.write(newPassword+"\n");
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
          this.storePassword(newPassword, callback)
        } else {
          callback(new Error("Failed to store new password"));
        }
      });

      passwd.on('error', (err) => {
        callback(new Error('Failed to start child process:' + err));
      });
    }

    verifyPassword(password, callback) {

      var pty = require('pty.js');
      const su = pty.spawn('bash',
          ["-i", "-c", "su " + process.env.USER + " -c 'ls &>/dev/null'"],
          {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            cwd: process.env.HOME,
            env: process.env
          }
        );

      var success = true;

      su.on('data', (data) => {
        switch(data.toString('utf8')) {
          case "Password: ":
            su.write(password+"\n");
            break;
          case "su: Authentication failure":
            success = false;
          default:
            break;
        }
      });

      su.on('close', (err) => {
        if(err || !success) {
          callback(new Error("Password Check Failed"));
        } else {
          callback(null, true);
        }
      });
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
