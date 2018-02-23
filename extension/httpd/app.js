'use strict';

const log = require("../../net2/logger")('httpd');

const express = require('express');
const https = require('https');
const forge = require('node-forge');
const qs = require('querystring');
const intel = require('./intel.js');

const port = 80;
const httpsPort = 443;
const app = express();
const enableHttps = false;
const enableRedis = true;

const promise = require('bluebird');
const redis = require('redis');
const client = redis.createClient();
promise.promisifyAll(redis.RedisClient.prototype);

const viewsPath = 'firewalla_views';

app.engine('pug', require('pug').__express);
app.set('views', './firewalla_views');
app.set('view engine', 'pug');

let router = express.Router();

router.all('/green', async (req, res) => {
  const hostname = req.hostname;
  const url = qs.unescape(req.query.url);
  const ip = req.ip;
  const method = req.method;

  log.info("Got a request in porn views");

  res.render('green', {hostname, url, ip, method});
})

app.use(`/${viewsPath}`, router);

app.use('*', async (req, res) => {
  log.info("Got a request in *");

  if (!req.originalUrl.includes(viewsPath)) {
    let cat = await intel.check(req.hostname);

    log.info(`${req.hostname} 's category is ${cat}`);

    switch(cat) {
      case 'porn':
        isPorn(req, res);
        break;
      case 'ad':
        isAd(req, res);
        break;
      default:
        res.status(200).send().end();
    }
  }
});

function isPorn(req, res) {
  res.status(303).location(`/${viewsPath}/green?${qs.stringify({url: req.originalUrl})}`).send().end();
  if (enableRedis) {
    client.hincrbyAsync('block:stats', 'porn', 1).then(value => {
      log.info(`Total porn blocked: ${value}`);
    });
  }
}

function isAd(req, res) {
  res.status(200).send().end();
  if (enableRedis) {
    client.hincrbyAsync('block:stats', 'ad', 1).then(value => {
      log.info(`Total ad blocked: ${value}`);
    });
  }
}

app.listen(port, () => log.info(`Httpd listening on port ${port}!`));

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
