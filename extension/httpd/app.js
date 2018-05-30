'use strict';

const log = require("../../net2/logger")('httpd');

const express = require('express');
const https = require('https');
const forge = require('node-forge');
const qs = require('querystring');
const path = require('path');

const enableHttps = true;

const redirectHttpPort = 8880;
const redirectHttpsPort = 8883;
const blackHoleHttpPort = 8881;
const blackHoleHttpsPort = 8884;
const blockHttpPort = 8882;
const blockHttpsPort = 8885;


const Promise = require('bluebird');
const rclient = require('../../util/redis_manager.js').getRedisClient()

const intel = require('./intel.js')(rclient);

const VIEW_PATH = 'firewalla_view';
const STATIC_PATH = 'firewalla_static';

process.title = "FireBlue";

class App {
  constructor() {

    // redirect to a remote site
    this.redirectApp = express();

    // silently return 404
    this.blackHoleApp = express();

    // render a block page
    this.blockApp = express();

    this.blockApp.engine('mustache', require('mustache-express')());
    this.blockApp.set('view engine', 'mustache');

    this.blockApp.set('views', path.join(__dirname, VIEW_PATH));
    //this.redirectApp.disable('view cache'); //for debug only

    this.routes();
  }

  recordActivity(req, queue) {
    if(!req) {
      return;
    }

    const hostname = req.hostname;
    if(hostname) {
      rclient.zaddAsync(queue, Math.floor(new Date() / 1000), hostname);
    }
  }

  routesForRedirect() {
    this.redirectApp.use('*', async (req, res) => {
      let redirect = await rclient.hgetAsync('redirect','porn')
      redirect = redirect || "http://google.com"

      this.recordActivity(req, "history:domain:redirect");

      if(redirect) {
        res.status(303).location(redirect).send().end()
      }
    });
  }

  routesForBlackHole() {
    this.blackHoleApp.use('*', async (req, res) => {

      this.recordActivity(req, "history:domain:blackhole");

      res.status(200).send().end()

    });
  }

  routesForBlock() {
    this.router = express.Router();
    this.router.all('/block', async (req, res) => {
      const hostname = req.hostname;
      const url = qs.unescape(req.query.url);
      const ip = req.ip;
      const method = req.method;
      const count = qs.unescape(req.query.count);

      log.info("Got a request in block views");

      res.render('block', {hostname, url, ip, method, count});
    })

    this.blockApp.use('/' + VIEW_PATH, this.router);
    this.blockApp.use('/' + STATIC_PATH, express.static(path.join(__dirname, STATIC_PATH)));

    this.redirectApp.use('*', async (req, res) => {
      log.info("Got a request in *");

      if (!req.originalUrl.includes(VIEW_PATH)) {

        let cat = await intel.check(req.hostname);

        log.info(`${req.hostname} 's category is ${cat}`);

        switch(cat) {
          case 'porn':
            await this.isPorn(req, res);
            break;
          case 'ad':
            await this.isAd(req, res);
            break;
          default:
            res.status(200).send().end();
        }
      }
    });
  }

  routes() {
    this.routesForRedirect();
    this.routesForBlackHole();
    this.routesForBlock();
  }

  start() {
    this.redirectApp.listen(redirectHttpPort, () => log.info(`Httpd listening on port ${redirectHttpPort}!`));
    this.blackHoleApp.listen(blackHoleHttpPort, () => log.info(`Httpd listening on port ${blackHoleHttpPort}!`));
    this.blockApp.listen(blockHttpPort, () => log.info(`Httpd listening on port ${blockHttpPort}!`));

    if (enableHttps) {
      const httpsOptions = this.genHttpsOptions();
      https.createServer(httpsOptions, this.redirectApp).listen(redirectHttpsPort, () => log.info(`Httpd listening on port ${redirectHttpsPort}!`));
      https.createServer(httpsOptions, this.blackHoleApp).listen(blackHoleHttpsPort, () => log.info(`Httpd listening on port ${blackHoleHttpsPort}!`));
      https.createServer(httpsOptions, this.blockApp).listen(blockHttpsPort, () => log.info(`Httpd listening on port ${blockHttpsPort}!`));
    }
  }

  async isPorn(req, res) {
    let count = await rclient.hincrbyAsync('block:stats', 'porn', 1);
    let params = qs.stringify({hostname: req.hostname, url: req.originalUrl, count});
    let location = `/${VIEW_PATH}/block`;

    const redirect = await rclient.hgetAsync('redirect','porn')
    if(redirect) {
      res.status(303).location(redirect).send().end()
    } else {
      res.status(303).location(`${location}?${params}`).send().end();
    }

    log.info(`Total porn blocked: ${count}`);
  }

  async isAd(req, res) {
    res.status(200).send().end();
    let count = await rclient.hincrbyAsync('block:stats', 'ad', 1);
    log.info(`Total ad blocked: ${count}`);
  }

  genHttpsOptions() {
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
    log.info('Certificate created.');

    return {
      key: pki.privateKeyToPem(keys.privateKey),
      cert: pki.certificateToPem(cert)
    };
  }
}

new App().start();
