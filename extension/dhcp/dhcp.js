#!/usr/bin/env node
/*    Copyright 2016 Firewalla LLC / Firewalla LLC
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

const log = require("../../net2/logger.js")(__filename);

const util = require('util')

const Firewalla = require('../../net2/Firewalla.js');

const xml2jsonBinary = Firewalla.getFirewallaHome() + "/extension/xml2json/xml2json." + Firewalla.getPlatform();

const cp = require('child_process');

async function dhcpDiscover(intf) {
  intf = intf || "eth0";
  log.info("Broadcasting DHCP discover on ", intf);
  
  let cmd = util.format('sudo nmap --script broadcast-dhcp-discover -e %s -oX - | %s', intf, xml2jsonBinary);
  log.info("Running command:", cmd);

  return new Promise((resolve, reject) => {
    cp.exec(cmd, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      if (stderr) {
        if (!stderr.includes("No targets were specified")) { // this warning is as expected
          reject(new Error(stderr));
          return;
        }
      }

      let output = null;
      try {
        output = JSON.parse(stdout);
      } catch (err) {
          reject(err);
          return;
      }

      let kvs = output.nmaprun && output.nmaprun.prescript
        && output.nmaprun.prescript.script
        && output.nmaprun.prescript.script.table
        && output.nmaprun.prescript.script.table.elem;
      let msgType = null;
      let ipOffered = null;
      if (Array.isArray(kvs)) {
        kvs.forEach((elem) => {
          if (elem.key === "DHCP Message Type") {
              msgType = elem['#content'];
          }
          if (elem.key === "IP Offered") {
              ipOffered = elem['#content'];
          }
        });
        if (msgType === "DHCPOFFER" && ipOffered !== null) {
          // Got a DHCPOFFER response and a corresponding IP offer
          resolve(true);
          return;
        } else {
          resolve(false);
          return;
        }
      } else {
        resolve(false);
        return;
      }
    });
  });  
}

module.exports = {
  dhcpDiscover: dhcpDiscover
}

/*
dhcpDiscover("eth0").then((found) => {
  if (found) {
    console.log("DHCP service is found via eth0.");
  } else {
    console.log("DHCP service is not found via eth0.");
  }
}).catch((err) => {
  console.log("Failed to do DHCP discover", err);
});
*/