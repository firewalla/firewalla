/*    Copyright 2026 Firewalla Inc.
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
// Captive portal page server, runs on the box. The box sends HTTP of guests that have not logged
// in here; any GET gets the login page, POST /ok authorizes the guest's MAC through fwapc, and the
// box stops intercepting it. Node 12 compatible. Built into firewalla as a test version; the
// CaptivePortalPlugin runs the asset copy instead once one is installed.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DIR = __dirname;
// the box's own settings (config.json, logo), outside the code so updates keep them
const USER_DIR = process.env.USER_DIR || '';

// a missing or bad file counts as empty, so a bad edit never takes the portal down
function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(value) ? value : {};
  } catch (err) {
    return {};
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// after a login the page counts down and opens successUrl, by default the portal's own
// Success page, which turns the iOS sheet's button into Done
const DEFAULTS = {
  port: 8890,
  fwapc: 'http://127.0.0.1:8841',
  successUrl: '',
  successSeconds: 5,
  // page text; config.json is read on every request, so edits apply without a restart
  page: {
    title: 'Wi-Fi access',
    heading: 'Welcome',
    text: 'Tap OK to get Internet access.',
    button: 'OK',
    // an image file in USER_DIR or pages/, shown above the heading
    logo: '',
  },
};

// only fields of the default's type, so a bad value keeps the previous one
function pick(defaults, value) {
  const out = {};
  if (!isObject(value)) return out;
  for (const key of Object.keys(defaults))
    if (key in value && typeof value[key] === typeof defaults[key] && !isObject(defaults[key])) out[key] = value[key];
  return out;
}

function loadConfig() {
  const file = readJson(path.join(DIR, 'config.json'));
  const user = USER_DIR ? readJson(path.join(USER_DIR, 'config.json')) : {};
  const config = Object.assign({}, DEFAULTS, pick(DEFAULTS, file), pick(DEFAULTS, user));
  config.page = Object.assign({}, DEFAULTS.page, pick(DEFAULTS.page, file.page), pick(DEFAULTS.page, user.page));
  // the box's CaptivePortalPlugin passes these
  if (process.env.PORT) config.port = Number(process.env.PORT);
  if (process.env.FWAPC_URL) config.fwapc = process.env.FWAPC_URL;
  return config;
}

const config = loadConfig();
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif' };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
}

function log(msg) {
  console.log(new Date().toISOString() + ' ' + msg);
}

// read on every request, so page edits apply without a restart
function fill(text, vars) {
  for (const key of Object.keys(vars)) text = text.split('{{' + key + '}}').join(String(vars[key]));
  return text;
}

function render(name, vars) {
  const page = loadConfig().page;
  const text = {};
  for (const key of ['title', 'heading', 'text', 'button']) text[key] = escapeHtml(page[key]);
  text.logo = page.logo ? '<img class="logo" src="/logo" alt="">' : '';
  const body = fill(fs.readFileSync(path.join(DIR, 'pages', name + '.html'), 'utf8'), Object.assign(text, vars));
  // a full document (the Success page) is sent as is
  if (/^<html/i.test(body)) return body;
  const layout = fs.readFileSync(path.join(DIR, 'pages', 'layout.html'), 'utf8');
  return fill(layout, Object.assign({}, text, { content: body }));
}

function sendLogo(res) {
  const name = path.basename(String(loadConfig().page.logo || ''));
  const type = IMAGE_TYPES[path.extname(name).toLowerCase()];
  let data = null;
  for (const dir of [USER_DIR, path.join(DIR, 'pages')].filter(Boolean)) {
    try {
      data = type && fs.readFileSync(path.join(dir, name));
    } catch (err) { /* not in this folder */ }
    if (data) break;
  }
  if (!data) {
    res.writeHead(404, { Connection: 'close' });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store', Connection: 'close' });
  res.end(data);
}

function reply(res, code, name, vars) {
  const html = render(name, vars);
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    // a reused connection stays redirected after the login, so the OS check would see the
    // portal again and keep its sign-in sheet open
    Connection: 'close',
  });
  res.end(html);
}

// the box is the guest's gateway, so its neighbor table has the guest's MAC
function macOf(ip) {
  return new Promise(resolve => {
    execFile('ip', ['neigh', 'show', ip], (err, stdout) => {
      const m = !err && /lladdr ([0-9a-fA-F:]{17})/.exec(stdout || '');
      resolve(m ? m[1].toUpperCase() : null);
    });
  });
}

function fwapc(method, apiPath, body) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(config.fwapc + '/v1' + apiPath, {
      method,
      timeout: 10000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (err) { /* plain text error */ }
        resolve({ code: res.statusCode, body: json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', err => resolve({ code: 0, body: null, text: err.message }));
    if (data) req.write(data);
    req.end();
  });
}

async function login(req, res) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const mac = await macOf(ip);
  if (!mac) {
    log(`login from ${ip}: no MAC found`);
    return reply(res, 500, 'error');
  }
  // fwapc lists a new station up to ~15s after it connects, and the box shows the page before
  // that, so a quick tap waits for fwapc rather than failing
  let r = await fwapc('POST', '/captive/authorized', { mac });
  for (let i = 0; i < 20 && r.code === 400; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    r = await fwapc('POST', '/captive/authorized', { mac });
  }
  if (r.code !== 200 || !r.body) {
    log(`login of ${mac} (${ip}) failed: ${r.code} ${r.text}`);
    return reply(res, 500, 'error');
  }
  const hours = Math.round((r.body.expiresAt - r.body.createdAt) / 3600);
  log(`login of ${mac} (${ip}) on ${r.body.ssid} for ${hours}h`);
  // read now, so edits apply to the next login
  const current = loadConfig();
  const secs = Number(current.successSeconds) || 5;
  // the box takes the MAC off its redirect list on the login event, well within the countdown
  // the guest reached the box by a redirect, so the box address is the one it connected to
  const box = (req.socket.localAddress || '').replace(/^::ffff:/, '');
  const url = current.successUrl || `http://${box}:${config.port}/success`;
  reply(res, 200, 'done', { hours, secs, url: escapeHtml(url) });
}

const server = http.createServer((req, res) => {
  // drain any body before answering
  req.on('data', () => {});
  req.on('end', () => {
    if (req.method === 'POST' && req.url.split('?')[0] === '/ok') {
      login(req, res).catch(err => {
        log(`login failed: ${err.message}`);
        reply(res, 500, 'error');
      });
      return;
    }
    if (req.url.split('?')[0] === '/success') {
      reply(res, 200, 'success');
      return;
    }
    if (req.url.split('?')[0] === '/logo') {
      sendLogo(res);
      return;
    }
    // any other URL, captive checks included (captive.apple.com, generate_204), gets the login
    // page, which opens the OS sign-in sheet
    reply(res, 200, 'login');
  });
});

server.listen(config.port, () => log(`captive portal listening on ${config.port}`));
