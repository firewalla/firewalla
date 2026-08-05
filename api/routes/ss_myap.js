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

/*
 * GET /ss_myap : 302-redirect the requesting client to the speedtest UI of the
 * AP it is currently associated to. The AP is resolved per-request from live
 * fwapc association data, so roaming between APs is handled automatically.
 *
 *   client ip -> mac    : redis  hget host:ip4:<ip> mac
 *   mac       -> ap uid : fwapc  GET /status/station/<mac>  .info.assetUID
 *   ap uid    -> ap ip  : fwapc  GET /status/ap/<uid>       .info.addrs
 *                         (pick the AP ip in the client's network subnet, else br-lan0)
 */
'use strict';

const express = require('express');
const router = express.Router();

const log = require('../../net2/logger.js')(__filename);
const fwapc = require('../../net2/fwapc.js');
const sysManager = require('../../net2/SysManager.js');
const rclient = require('../../util/redis_manager.js').getRedisClient();
const { Address4 } = require('ip-address');

const AP_UI_PORT = 8833;
const AP_UI_PATH = '/ss/';

function unwrap(ip) {
  if (ip && ip.startsWith('::ffff:')) ip = ip.slice(7); // unwrap IPv4-mapped IPv6
  return ip;
}

// only a local reverse proxy (the box fronting this endpoint) is trusted to set
// x-forwarded-for / x-real-ip. loopback peers are the box itself.
function isTrustedProxy(ip) {
  return ip === '127.0.0.1' || ip === '::1';
}

// Resolve the requesting device's ip. Default to the socket peer so a LAN client
// cannot impersonate another device by sending its own x-forwarded-for header.
// Forwarded headers are honoured only when the immediate peer is a trusted proxy.
function clientIp(req) {
  const peer = unwrap((req.socket && req.socket.remoteAddress) || '');
  if (isTrustedProxy(peer)) {
    const fwd = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
    if (fwd) return unwrap(fwd.split(',')[0].trim());
  }
  return peer;
}

async function redisMac(ip) {
  const mac = await rclient.hgetAsync(`host:ip4:${ip}`, 'mac').catch(() => null);
  return mac ? mac.toUpperCase() : null;
}

// resolve the AP uid a station (by MAC) is associated to; graceful null on any non-200.
async function apUidForStation(mac) {
  const resp = await fwapc.apiCall('GET', `/status/station/${mac}`).catch(() => null);
  if (!resp || resp.code !== 200 || !resp.body) return null;
  return (resp.body.info || {}).assetUID || null;
}

// resolve the CIDR subnet(s) of the box network the client ip belongs to.
// box networks are cached in sysManager, sourced from fwapc GET /v1/config/active,
// so this honours any valid prefix length (/16, /23, /25, ...) rather than a /24 guess.
function clientSubnets(clientAddr) {
  const intf = sysManager.getInterfaceViaIP4(clientAddr, false);
  if (intf && Array.isArray(intf.ip4_subnets) && intf.ip4_subnets.length) return intf.ip4_subnets;
  if (intf && intf.subnet) return [intf.subnet];
  return [];
}

function isValidIp4(ip) {
  return typeof ip === 'string' && new Address4(ip).isValid();
}

async function apIpForUid(uid, clientAddr) {
  const resp = await fwapc.apiCall('GET', `/status/ap/${uid}`).catch(() => null);
  if (!resp || resp.code !== 200 || !resp.body) return null;
  const addrs = (resp.body.info || {}).addrs || {};
  // only keep syntactically valid ipv4 candidates so we never build a malformed redirect
  const ips = Object.values(addrs).map(a => a && a.ip4).filter(isValidIp4);

  // prefer the AP address that is actually reachable within the client's own subnet
  const subnets = clientSubnets(clientAddr).map(s => new Address4(s)).filter(s => s.isValid());
  if (subnets.length) {
    const same = ips.find(ip => subnets.some(s => new Address4(ip).isInSubnet(s)));
    if (same) return same;
  }

  const br0 = (addrs['br-lan0'] || {}).ip4;
  if (isValidIp4(br0)) return br0;
  return ips[0] || null;
}

router.get(['/', '/*'], async (req, res) => {
  const ip = clientIp(req);
  let mac = null;
  try {
    mac = await redisMac(ip);
    const uid = mac ? await apUidForStation(mac) : null;
    if (!uid) {
      res.status(404).send(`no associated ap for ip=${ip} mac=${mac}`);
      return;
    }
    const apIp = await apIpForUid(uid, ip);
    if (!apIp) {
      res.status(404).send(`no ip for ap ${uid}, device ip=${ip}, device mac=${mac}`);
      return;
    }
    const target = `http://${apIp}:${AP_UI_PORT}${AP_UI_PATH}`;
    log.info(`ss_myap ip=${ip} mac=${mac} ap=${uid} -> ${target}`);
    res.set('Cache-Control', 'no-store');
    res.redirect(302, target);
  } catch (err) {
    log.error(`ss_myap error for ip=${ip} mac=${mac}:`, err.message);
    res.status(502).send(err.message);
  }
});

module.exports = router;
