#!/usr/bin/env node
/*    Copyright 2016-2022 Firewalla Inc.
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

const cp = require('child_process');
const execAsync = require('child-process-promise').exec;
const fs = require('fs');
const fsp = require('fs').promises;
const _ = require('lodash');
const util = require('util');

const Config = require('../../net2/config.js');
const Firewalla = require('../../net2/Firewalla.js');
const log = require("../../net2/logger.js")(__filename);

const xml2jsonBinary = Firewalla.getFirewallaHome() + "/extension/xml2json/xml2json." + Firewalla.getPlatform();

async function broadcastDhcpDiscover(intf, macAddr=null, options=null) {
  if (!intf) {
    const config = await Config.getConfig(true);
    intf = config.monitoringInterface;
  }
  if (!macAddr) {
    macAddr = 'rand';
  }
  log.debug("Broadcasting DHCP discover on ", intf, macAddr);
  let scriptName = await getScriptName("broadcast-dhcp-discover", options);
  let scriptArgs = getScriptArgs(["broadcast-dhcp-discover.mac="+macAddr], options);
  let cmd = util.format('sudo timeout 1200s nmap --script %s %s -e %s -oX - | %s', scriptName, scriptArgs, intf, xml2jsonBinary);
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
      let kvs = _.get(output, `nmaprun.prescript.script.table.elem`, []);
      let msgType = null;
      let ipOffered = null;
      let result = {};
      if (Array.isArray(kvs)) {
        kvs.forEach((elem) => {
          result[elem.key.replace(/\s/g, '')] = elem['#content']
          if (elem.key === "DHCP Message Type") {
              msgType = elem['#content'];
          }
          if (elem.key === "IP Offered") {
              ipOffered = elem['#content'];
          }
        });
        if (msgType === "DHCPOFFER" && ipOffered !== null) {
          // Got a DHCPOFFER response and a corresponding IP offer
          result['ok'] = true;
          resolve(result);
          return;
        } else {
          result['ok'] = false;
          resolve(result);
          return;
        }
      } else {
        result['ok'] = false;
        resolve(result);
        return;
      }
    });
  });  
}

async function broadcastDhcp6Discover(intf) {
  let result = {ok: false};
  if (!intf) {
    const config = await Config.getConfig(true);
    intf = config.monitoringInterface;
  }
  let cmd = util.format('sudo timeout 1200s nmap -6 --script broadcast-dhcp6-discover -e %s -oX - | %s', intf, xml2jsonBinary);
  log.info("Running command:", cmd);
  try {
    const cmdresult = await execAsync(cmd);
    let output = JSON.parse(cmdresult.stdout);
    let kvs = _.get(output, `nmaprun.prescript.script.table.elem`, []); // TODO: fix broadcast-dhcp6-discover path
    if (_.isArray(kvs)) {
      for (const item of kvs) {
        result[item.key.replace(/\s/g, '')] = elem['#content'];
      }
      result['ok'] = true;
    }
  } catch(err) {
    log.error("Failed to nmap scan:", err);
    result['err'] = `fail to run nmap broadcast-dhcp6-discover ${serverIp}` + err.message;
  }
}

async function dhcpDiscover(serverIp, macAddr=null, options=null) {
  if (!serverIp) {
    return {'ok': false, 'err': 'must specify target address'};
  }
  if (!macAddr) {
    macAddr = 'random';
  }
  let scriptName = await getScriptName('dhcp-discover', options);
  let scriptArgs = getScriptArgs(["mac="+macAddr],options);
  let cmd = util.format('sudo timeout 1200s nmap -sU -p 67 --script=%s %s %s -oX - | %s', scriptName, scriptArgs, serverIp, xml2jsonBinary);
  log.info("Running command:", cmd);
  let result = {};
  try {
    const cmdresult = await execAsync(cmd);
    let output = JSON.parse(cmdresult.stdout);
    let kvs = _.get(output, `nmaprun.host.ports.port.script.elem`, []);
    if (_.isArray(kvs)) {
      for (const item of kvs) {
        result[item.key.replace(/\s/g, '')] = item['#content'];
      }
      if (result.DHCPMessageType && result.DHCPMessageType != "DHCPACK") {
        log.warn(`expect dhcp-discover reply message type DHCPACK but '${result.DHCPMessageType}'`)
      }
      if (result.ServerIdentifier) {
        result['ok'] = true;
      } else {
        result['ok'] = false;
      }
    }
  } catch(err) {
    log.error("Failed to nmap scan:", err);
    result['err'] = `fail to run nmap dhcp-discover ${serverIp}, ` + err.message;
  }
  return result;
}

async function getScriptName(scriptName, options) {
  let customScript = scriptName;
  if (options && options.script) {
    const dhcpScript = Firewalla.getHiddenFolder() + "/run/assets/" + options.script;
    if (await fsp.access(dhcpScript, fs.constants.F_OK).then(() => true).catch((err) => false)) {
      customScript = dhcpScript;
    }
  }
  return customScript;
}

function getScriptArgs(args, options) {
  if (!_.isArray(args)) {
    return ''
  }
  if (options && options.scriptArgs) {
    args = args.concat(options.scriptArgs.split(','))
  }
  return '--script-args ' + args.join(',');
}

async function dhcpServerStatus(serverIp) {
  let result = false;
  let cmd = util.format('sudo timeout 1200s nmap -sU -p 67 --script=dhcp-discover %s -oX - | %s', serverIp, xml2jsonBinary);
  log.info("Running command:", cmd);
  try {
    const cmdresult = await execAsync(cmd);
    let output = JSON.parse(cmdresult.stdout);
    let kvs = _.get(output, `nmaprun.host.ports.port.script.elem`, []);
    if (Array.isArray(kvs) && kvs.length > 0) {
      result = true;
    }
  } catch(err) {
    log.error("Failed to nmap scan:", err);
  }

  return result
}

module.exports = {
  dhcpDiscover: dhcpDiscover,
  broadcastDhcpDiscover: broadcastDhcpDiscover,
  broadcastDhcp6Discover: broadcastDhcp6Discover,
  dhcpServerStatus: dhcpServerStatus
}
