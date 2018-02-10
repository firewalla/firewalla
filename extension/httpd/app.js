'use strict';

const express = require('express');
const https = require('https');
const forge = require('node-forge');
const URL = require('url');
const Path = require('path');
const fs = require('fs');

const port = 8000;
const httpsPort = 443;
const app = express();
const enableHttps = false;
const enableRedis = false;

/*
if (enableRedis) {
  const promise = require('bluebird');
  const redis = require('redis');
  const client = redis.createClient();
  promise.promisifyAll(redis.RedisClient.prototype);
}
*/

const staticDirname = '/firewalla_views';
const staticAbsDirname = '/home/pi/firewalla/extension/httpd' + staticDirname;

app.engine('pug', require('pug').__express);
app.set('views', './firewalla_views');
app.set('view engine', 'pug');

function isPorn(dn) {
  return true;
}

let router = express.Router();

router.all('/porn', (req, res) => {
  console.info("Got a request in porn views");
  let message = `Porn Blocked by Firewalla: ${req.ip} => ${req.method}: ${req.hostname}${req.originalUrl}`;
  res.render('green', {message});
})

app.use('/firewalla_views', router);

app.use('*', (req, res) => {
  console.info("Got a request in *");

  if (!req.originalUrl.includes('firewalla_views')) {
    if (isPorn(req.hostname)) {
      res.status(301).location(`/firewalla_views/porn?url=${req.originalUrl}`).send().end();
      return;
    }
  }

  if (enableRedis) {
    client.hincrbyAsync('block:stats', 'adblock', 1).then(value => {
      console.log(`${txt}, Total blocked: ${value}`);
    });
  }
});

app.listen(port, () => console.log(`Httpd listening on port ${port}!`));

if (enableHttps) {
  const httpsOptions = genHttpsOptions();
  https.createServer(httpsOptions, app).listen(httpsPort, () => console.log(`Httpd listening on port ${httpsPort}!`));
}

function genHttpsOptions() {
  // generate a keypair and create an X.509v3 certificate
  const pki = forge.pki;
  console.log('Generating 1024-bit key-pair...');
  const keys = pki.rsa.generateKeyPair(1024);
  console.log('Key-pair created.');

  console.log('Creating self-signed certificate...');
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  let attrs = [{
    name: 'commonName',
    value: 'blackhole.firewalla.com'
  }, {
    name: 'countryName',
    value: 'US'
  }, {
    shortName: 'ST',
    value: 'New York'
  }, {
    name: 'localityName',
    value: 'Brooklyn'
  }, {
    name: 'organizationName',
    value: 'BLACKHOLE'
  }, {
    shortName: 'OU',
    value: 'BLACKHOLE'
  }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{
    name: 'basicConstraints',
    cA: true/*,
    pathLenConstraint: 4*/
  }, {
    name: 'keyUsage',
    keyCertSign: true,
    digitalSignature: true,
    nonRepudiation: true,
    keyEncipherment: true,
    dataEncipherment: true
  }, {
    name: 'extKeyUsage',
    serverAuth: true,
    clientAuth: true,
    codeSigning: true,
    emailProtection: true,
    timeStamping: true
  }, {
    name: 'nsCertType',
    client: true,
    server: true,
    email: true,
    objsign: true,
    sslCA: true,
    emailCA: true,
    objCA: true
  }]);
  cert.sign(keys.privateKey);
  console.log('Certificate created.');

  return {
    key: pki.privateKeyToPem(keys.privateKey),
    cert: pki.certificateToPem(cert)
  };
}