/*    Copyright 2016-2020 Firewalla Inc.
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
let instance = null;

// openssl verify errors (X509_verify_cert_error_string) as stable values for the app
const CERT_ERRORS = {
  "unable to get issuer certificate": "cert_invalid_issuer",
  "unable to get local issuer certificate": "cert_invalid_issuer",
  "unable to verify the first certificate": "cert_invalid_issuer",
  "self signed certificate in certificate chain": "cert_invalid_issuer",
  "certificate has expired": "cert_expired",
  "certificate is not yet valid": "cert_not_yet_valid",
};

const sysManager = require('../../net2/SysManager.js')
const fc = require('../../net2/config.js')
const conntrack = require('../../net2/Conntrack.js')
const Constants = require('../../net2/Constants.js')
const IntelTool = require('../../net2/IntelTool.js')
const intelTool = new IntelTool()
const _ = require('lodash')
const validator = require('validator')

const HostTool = require('../../net2/HostTool.js');
const hostTool = new HostTool();

const log = require('../../net2/logger.js')(__filename);

// issuers whose chains fail validation for known benign reasons, used until the cloud hashset gives a list
const DEFAULT_IGNORED_ISSUERS = [
  "CN=Microsoft ECC Product Root Certificate Authority 2018,O=Microsoft Corporation,L=Redmond,ST=Washington,C=US",
  "CN=Microsoft Root Certificate Authority 2011,O=Microsoft Corporation,L=Redmond,ST=Washington,C=US",
];

class BroNotice {
  constructor() {
    if (instance === null) {
      instance = this;
      this.setIgnoredIssuers(null);
    }
  }

  // FireMain only; required here, it opens a redis subscription when loaded
  startIgnoredIssuersLoader() {
    const CloudConfigLoader = require('../../sensor/CloudConfigLoader.js');
    this.ignoredIssuersLoader = new CloudConfigLoader({
      cacheKey: Constants.REDIS_KEY_INVALID_CERT_IGNORED_ISSUERS_CLOUD_CONFIG,
      hashsetName: Constants.KEY_INVALID_CERT_IGNORED_ISSUERS,
      label: 'invalid cert ignored issuers',
      apply: dns => this.setIgnoredIssuers(dns),
      acceptEmpty: true // an emptied cloud list brings the default list back
    });
    return this.ignoredIssuersLoader.start();
  }

  // an array of DN strings from the cloud replaces the default list
  setIgnoredIssuers(dns) {
    if (!Array.isArray(dns) || !dns.length) dns = DEFAULT_IGNORED_ISSUERS;
    this.ignoredIssuers = dns.filter(_.isString).map(dn => intelTool.parseDN(dn));
  }

  // compared attribute by attribute, so the order of the DN doesn't matter
  isIgnoredIssuer(issuer) {
    return this.ignoredIssuers.some(dn => _.isEqual(dn, issuer));
  }

  // zeek's src is the client; sets p.local_is_client and returns whether the alarm device is it
  localIsClient(alarm, broObj) {
    const isClient = alarm["p.device.ip"] == broObj.src;
    alarm["p.local_is_client"] = isClient ? "1" : "0";
    return isClient;
  }

  //  src: guesser
  //  sub: target
  //  dst: no presence
  async processSSHScan(alarm, broObj) {
    const subMessage = broObj.sub
    // sub message:
    //   Sampled servers:  10.0.1.182, 10.0.1.182, 10.0.1.182, 10.0.1.182, 10.0.1.182

    let addresses = subMessage.replace(/.*Sampled servers: {2}/, '').split(", ")
    addresses = addresses.filter((v, i, array) => {
      return array.indexOf(v) === i
    })

    if (addresses.length == 0) {
      alarm["p.local.decision"] = "ignore";
      return null;
    }
    let deivceNames = [];
    for (const address of addresses) {
      let deviceName = await hostTool.getName(address);
      deviceName = deviceName ? deviceName : address;
      deivceNames.push(deviceName)
    }

    let target = addresses[0];

    if (this.localIsClient(alarm, broObj)) {
      // attacker is internal device
      alarm["p.dest.ip"] = target;
    } else {
      // attacker is external device
      alarm["p.device.ip"] = target;
      alarm["device"] = target;
    }

    alarm["p.message"] = `${alarm["p.message"].replace(/\.$/, '')} on device: ${deivceNames.join(",")}`
  }

  //  src: scanner
  //  dst: target
  //  sub: "local" || "remote"
  async processPortScan(alarm, broObj) {
    this.localIsClient(alarm, broObj);
    // zeek's src is always the scanner, but BroDetect files the alarm under the target
    // when src is not a local device, so the scanner is p.dest.ip in that case
    const scanner = alarm["p.local_is_client"] == "1" ? alarm["p.device.ip"] : alarm["p.dest.ip"];
    const target = alarm["p.local_is_client"] == "1" ? alarm["p.dest.ip"] : alarm["p.device.ip"];
    let srcName = null;
    let dstName = null;
    if (sysManager.isLocalIP(scanner)) {
      srcName = await hostTool.getName(scanner);
    }
    if (sysManager.isLocalIP(target)) {
      dstName = await hostTool.getName(target);
    }
    alarm['p.message'] = `${srcName ? srcName : scanner} was scanning ports of ${dstName ? dstName + `(${target})`: target}.`;
  }

  async processHeartbleed(alarm, broObj) {
    if (!this.localIsClient(alarm, broObj)) {
      // initiated from outside
      alarm["p.action.block"] = true; // block automatically if initiated from outside in
    }

    if (alarm['p.noticeType'] == 'Heartbleed::SSL_Heartbeat_Attack_Success')
      alarm['p.action.block'] = true; // block automatically if attack succeed
  }

  //  sub: interesting host name
  async processSSHInterestingLogin(alarm, broObj) {
    const sub = broObj["sub"];

    if (sub) {
      alarm["p.dest.name"] = sub;
    }
  }

  // on HTTP src/dst compiles with HTTP connection
  // sub: match description link
  async processTeamCymru(alarm, broObj) {
    if (!this.localIsClient(alarm, broObj)) {
      // initiated from outside
      alarm["p.action.block"] = true; // block automatically if initiated from outside in
    }

    if (broObj["file_mime_type"]) {
      alarm["p.file.type"] = broObj["file_mime_type"];
    }

    if (broObj["file_desc"]) {
      alarm["p.file.desc"] = broObj["file_desc"];
    }

    if (broObj.sub) {
      alarm["p.malware.reference"] = broObj.sub;
    }
  }

  //  src: tls client
  //  dst: tls server
  async processInvalidServerCert(alarm, broObj) {
    if (!fc.isFeatureOn("cyber_security.invalidServerCert")) return false;
    // local servers are dropped: self-signed NAS, printer and router UIs would only be noise
    if (!this.localIsClient(alarm, broObj) || sysManager.isLocalIP(broObj.dst)) {
      log.verbose("Ignoring invalid server cert notice", broObj);
      return false;
    }
    // zeek's msg is "SSL certificate validation failed with (<openssl error>)", newer openssl spells "self-signed"
    const status = ((/\((.*)\)$/.exec(broObj.msg) || [])[1] || "").replace("self-signed", "self signed");
    if (status == "self signed certificate") {
      log.verbose("Ignoring self-signed server cert notice", broObj);
      return false;
    }
    alarm["p.dest.ssl.validation_status"] = CERT_ERRORS[status] || "cert_invalid";
    // a CN that is no domain, e.g. "Mijia Cloud", is a private CA's device cert, never meant for public CA validation
    const cns = [].concat(intelTool.parseDN(broObj.sub || "").CN || []);
    if (cns.length && !cns.some(cn => validator.isFQDN(cn.startsWith("*.") ? cn.slice(2) : cn, { allow_underscores: true }))) {
      log.verbose("Ignoring invalid server cert notice of a non-domain CN", broObj.sub);
      return false;
    }
    // the failure processSslData saved for this server, here so known false positives are dropped before an alarm exists
    try {
      const issuer = await intelTool.getCertFailedIssuer(broObj.dst);
      if (issuer && this.isIgnoredIssuer(issuer)) {
        log.verbose("Ignoring invalid server cert notice of an ignored issuer", issuer);
        return false;
      }
      if (issuer) alarm["p.dest.ssl.validation_failed_issuer"] = issuer;
    } catch (err) {
      log.warn("Failed to look up the failed issuer for invalid server cert notice", err.message);
    }
    // the SNI cached by processSslData at ClientHello, which DestInfoIntel keeps as the dest name
    try {
      const host = await conntrack.getConnEntry(broObj["id.orig_h"], broObj["id.orig_p"], broObj["id.resp_h"], broObj["id.resp_p"], "tcp", Constants.REDIS_HKEY_CONN_HOST);
      if (host) alarm["p.dest.name"] = host;
    } catch (err) {
      log.warn("Failed to look up server name for invalid server cert notice", err.message);
    }
    return true;
  }

  //  src: victim
  //  dst: no presence
  // not localIsClient: here zeek's src is the attacked server, so the direction is inverse
  async processSQLInjection(alarm, broObj) {
    if (alarm["p.device.ip"] == broObj.src) {
      alarm["p.local_is_client"] = "0";
      alarm["p.action.block"] = true;
    } else {
      alarm["p.local_is_client"] = "1";
    }
  }

  async processNotice(alarm, broObj) {
    const noticeType = alarm["p.noticeType"];

    if (!noticeType || !broObj) {
      log.warn('Invalid bro notice', broObj)
      return null;
    }

    // ignore notice triggered by Firewalla itself
    if (sysManager.isMyIP(broObj.src) || sysManager.isMyIP6(broObj.src)) {
      log.info("Ignoring bro notice", broObj)
      return null;
    }

    alarm["e.bro.raw"] = JSON.stringify(broObj);

    switch (noticeType) {
      case "SSH::Password_Guessing":
        await this.processSSHScan(alarm, broObj);
        break;

      case "Heartbleed::SSL_Heartbeat_Attack":
      case "Heartbleed::SSL_Heartbeat_Attack_Success":
        await this.processHeartbleed(alarm, broObj);
        break;

      case "Scan::Port_Scan":
        await this.processPortScan(alarm, broObj);
        break;

      case "SSH::Interesting_Hostname_Login":
        await this.processSSHInterestingLogin(alarm, broObj);
        break;

      case "TeamCymruMalwareHashRegistry::Match":
        await this.processTeamCymru(alarm, broObj);
        break;

      case 'HTTP::SQL_Injection_Victim':
        await this.processSQLInjection(alarm, broObj);
        break

      case "SSL::Invalid_Server_Cert":
        if (!await this.processInvalidServerCert(alarm, broObj)) return null;
        break;

      case 'Signatures::Sensitive_Signature':
        // should dealing with signature event here?
      default:
        // do nothing
        log.verbose(`Unsupported zeek notice type ${noticeType}, ignored`, noticeType);
        log.verbose(broObj)
        return null;
    }
    return alarm;
  }

  getBlockTarget(alarm) {
    return {
      type: "ip",
      target: alarm["p.dest.ip"]
    }
  }
}

module.exports = new BroNotice();
