/*    Copyright 2019-2026 Firewalla Inc.
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

const log = require('./logger.js')(__filename);
const ipsetControl = require('../control/IpsetControl.js');
const { exec, execFile } = require('child-process-promise');
const f = require('./Firewalla.js');
const _ = require('lodash');

const REGEX_SETNAME = /^[A-Za-z0-9_][A-Za-z0-9_:/+-]{0,30}$/;

// without setName, read all sets and always returns an array
// with setName, read one set and returns either an object or null
async function read(setName, metaOnly = false) {
  const xml2jsonBinary = `${f.getFirewallaHome()}/extension/xml2json/xml2json.${f.getPlatform()}`;
  // the name is interpolated into the shell command below, so an unexpected one is a caller bug
  // rather than a set that might exist
  if (setName && !REGEX_SETNAME.test(setName)) {
    log.error('Invalid ipset name', JSON.stringify(setName));
    return null;
  }
  try {
    const result = await exec(`sudo timeout 120s ipset list ${metaOnly?'-t':''} ${setName||''} -output xml | ${xml2jsonBinary}`, {maxBuffer: 10 * 1024 * 1024})
    const jsonResult = _.get(JSON.parse(result.stdout), 'ipsets.ipset')
    if (Array.isArray(jsonResult))
      return jsonResult
    else if (_.isEmpty(jsonResult)) {
      log.verbose('Read: empty response', setName, result.stderr.trim())
      if (setName) return null
      else return []
    } else if (setName) return jsonResult
    else return [ jsonResult ]
  } catch(err) {
    log.error(`Failed to read ipset ${setName} to json`, err.message);
    return []
  }
}

async function readAllIpsets() {
  const jsonResult = await read()
  const result = {};
  for (const set of jsonResult) {
    const name = set.name;
    const elements = [];
    if (set.members && set.members.member) {
      if (_.isArray(set.members.member)) {
        for (const member of set.members.member) {
          if (member.elem)
            elements.push(member.elem);
        }
      } else {
        if (_.isObject(set.members.member)) {
          if (set.members.member.elem)
            elements.push(set.members.member.elem);
        }
      }
    }
    result[name] = elements;
  }
  return result;
}

async function isReferenced(ipset) {
  try {
    const setMeta = await read(ipset, true);
    if (!setMeta) return false;
    const references = Number(_.get(setMeta, 'header.references'))
    return references != 0;
  } catch(err) {
    log.error(`Failed to check if ipset ${ipset} is referenced`, err.message);
    return false;
  }
}

async function destroy(setName) {
  if (setName && !await isReferenced(setName))
    return ipsetControl.addRule(`destroy ${setName}`);
}

function flush(setName) {
  if (setName)
    return ipsetControl.addRule(`flush ${setName}`);
}

// seems that maxelem doesn't really effect memory usage
function create(name, type, v6 = false, options = {}) {
  let { timeout, hashsize = 128, maxelem = 65536, comment } = options
  let cmd = `create ${name} ${type}`;
  switch(type) {
    case 'bitmap:port':
      cmd += ' range 0-65535';
      break;
    case 'hash:mac':
      cmd += ` hashsize ${hashsize} maxelem ${maxelem}`
      break;
    case 'list:set':
      break
    default: {
      let family = ' family inet';
      if (v6) family = family + '6';
      cmd += family + ` hashsize ${hashsize} maxelem ${maxelem}`
    }
  }
  if (Number.isInteger(timeout))
    cmd += ` timeout ${timeout}`;
  if (options.skbinfo) cmd += ' skbinfo';
  if (comment) cmd += ` comment`;
  return ipsetControl.addRule(cmd);
}

function add(name, target, options = {}, allowDeferredExec = false) {
  const { timeout, comment, skbmark, skbprio, skbqueue } = options;
  let cmd = `add ${name} ${target}`;
  if (timeout !== undefined && timeout !== null && Number.isInteger(Number(timeout))) cmd += ` timeout ${timeout}`;
  if (comment) cmd += ` comment ${comment}`;
  if (skbmark) cmd += ` skbmark ${skbmark}`;
  if (skbprio) cmd += ` skbprio ${skbprio}`;
  if (skbqueue) cmd += ` skbqueue ${skbqueue}`;
  return ipsetControl.addRule(cmd, allowDeferredExec);
}

function del(name, target, allowDeferredExec = false) {
  return ipsetControl.addRule(`del ${name} ${target}`, allowDeferredExec);
}

function swap(name1, name2) {
  return ipsetControl.addRule(`swap ${name1} ${name2}`);
}

function restore(ops, allowDeferredExec = false) {
  return ipsetControl.restore(ops, allowDeferredExec);
}

async function list(name) {
  try {
    const result = await execFile('sudo', ['ipset', '-S', name]);
    const lines = result.stdout.split('\n')
    lines.pop()
    return lines
      .filter(line => line.startsWith('add'))
      .map(str => str.substring(name.length + 5)) // 'add <name> <target>'
  } catch(err) {
    if (err.name == 'ChildProcessError') {
      log.warn(name, err.stderr) // set not exist
      return []
    }

    throw err
  }
}

function batchOp(operations) {
  return ipsetControl.restore(operations, true);
}

const CONSTANTS = {
  IPSET_MONITORED_NET: "monitored_net_set",
  IPSET_LAN: "c_lan_set",
  IPSET_ACL_OFF: "acl_off_set",
  IPSET_ACL_OFF_MAC: "acl_off_mac_set",
  IPSET_NO_DNS_BOOST: "no_dns_caching_set",
  IPSET_NO_DNS_BOOST_MAC: "no_dns_caching_mac_set",
  IPSET_QOS_OFF: "qos_off_set",
  IPSET_QOS_OFF_MAC: "qos_off_mac_set",
  IPSET_NTP_OFF: "ntp_off_set",
  IPSET_MATCH_ALL_SET4: "match_all_set4",
  IPSET_MATCH_ALL_SET6: "match_all_set6",
  IPSET_MATCH_DNS_PORT_SET: "match_dns_port_set",
  IPSET_DOCKER_WAN_ROUTABLE: 'docker_wan_routable_net_set',
  IPSET_DOCKER_LAN_ROUTABLE: 'docker_lan_routable_net_set',
  IPSET_NETWORK_GATEWAY_SET: "c_network_gateway_set",
  IPSET_CLASH_BLACKLIST: "fw_clash_blacklist",
  IPSET_CLASH_WHITELIST: "fw_clash_whitelist",
  IPSET_CLASH_WHITELIST_NET: "fw_clash_whitelist_net",
  IPSET_CLASH_WHITELIST_MAC: "fw_clash_whitelist_mac",
  // never send traffic destined to these into clash
  CLASH_EXCLUDED_NETS: [
    "0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4"
  ]
}

module.exports = {
  isReferenced,
  destroy,
  flush,
  create,
  add,
  del,
  swap,
  restore,
  list,
  batchOp,
  CONSTANTS,
  REGEX_SETNAME,
  read,
  readAllIpsets
}
