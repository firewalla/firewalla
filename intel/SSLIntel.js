/*    Copyright 2016-2026 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename);

const Intel = require('./Intel.js');

// written by BroDetect.saveCertValidationFailure for a failed handshake, they describe the invalid cert alarm only
const CERT_FAILURE_FIELDS = ["validation_status", "cert_chain"];

class SSLIntel extends Intel {
  async enrichAlarm(alarm) {
    const IntelTool = require('../net2/IntelTool.js');
    const intelTool = new IntelTool();

    let ip = alarm["p.dest.ip"];
    if (ip) {
      try {
        let sslInfo = await intelTool.getSSLCertificate(ip);
        if (sslInfo) {
          log.verbose("Got ssl info of " + ip + ": " + JSON.stringify(sslInfo));
          const invalidCert = alarm["p.noticeType"] == "SSL::Invalid_Server_Cert";
          for (var key in sslInfo) {
            // BroNotice puts these on the alarm as basic fields, the only place dedup can read them
            if (key == "validation_failed_issuer" || key == "validation_failed_fp") continue;
            if (!invalidCert && CERT_FAILURE_FIELDS.includes(key)) continue;
            let detailKey = "e.dest.ssl." + key;
            alarm[detailKey] = sslInfo[key];
          }
        }
      } catch (err) {
          log.error("Failed to get ssl cert info: " + err);
      }
    }
    return alarm;
  }
}

module.exports = SSLIntel;