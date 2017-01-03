'use strict';
var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;

var fs = require('fs');

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


// test password
ssh.resetRandomPassword((result) => {
  expect(result).to.be.null;
  ssh.getPassword((err, password) => {
    expect(err).to.be.null;
    ssh.verifyPassword(password, (err, result) => {
      expect(err).to.be.null;
      expect(result).to.be.true;
    })
  })
})


setTimeout(function() {
    process.exit();
},3000);
