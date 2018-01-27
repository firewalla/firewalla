'use strict';

const express = require('express');
const https = require('https');
const forge = require('node-forge');

const port = 80;
const httpsPort = 443;
const app = express();
const httpsOptions = genHttpsOptions();

app.use('*', (req, res) => {
  let txt = `Ads Blocked by Firewalla: ${req.ip} => ${req.method}: ${req.hostname}${req.originalUrl}`;
  res.send(txt);
  console.log(txt);
});

app.listen(port, () => console.log(`Httpd listening on port ${port}!`));
https.createServer(httpsOptions, app).listen(httpsPort, () => console.log(`Httpd listening on port ${httpsPort}!`));

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