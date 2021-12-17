'use strict';
var chai = require('chai');
var expect = chai.expect;

let SSH = require('../extension/ssh/ssh.js');
let ssh = new SSH('debug');

ssh.removeRSAKeyPair();
expect(ssh.keyExists()).to.not.be.ok;

ssh.generateRSAPair((err) => {
  expect(err).to.not.be.ok;
  expect(ssh.keyExists()).to.be.ok;

  ssh.removePreviousKeyFromAuthorizedKeys((err) => {
    expect(err).to.not.be.ok;
  
    ssh.appendAuthorizedKeys((err) => {
      expect(err).to.not.be.ok;

      // a summarized action
      ssh.resetRSAPassword((err) => {
        expect(err).to.not.be.ok;
        ssh.getPrivateKey((err, data) => {
          expect(err).to.not.be.ok;
          // console.log(data);
        });
      });
    });    
  });

});


function verifyPassword(password, callback) {

  var pty = require('node-pty');
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
        break;
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

// test password
ssh.resetRandomPassword().then(() => {
  ssh.loadPassword().then((obj) => {
    verifyPassword(obj && obj.password, (err, result) => {
      expect(err).to.be.null;
      expect(result).to.be.true;
    })
  })
})


setTimeout(function() {
    process.exit();
},3000);
