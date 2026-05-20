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

const log = require('../net2/logger.js')(__filename);

const net = require('net');
const exec = require('child-process-promise').exec;
const fc = require('../net2/config.js');

const DEFAULT_TIMEOUT = 3;
const DEFAULT_TRIES = 2;
const DEFAULT_VERIFICATION_DOMAINS = ["firewalla.encipher.io", "github.com", "api.firewalla.com"];

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getVerificationDomains(domains) {
  if (Array.isArray(domains) && domains.length > 0)
    return domains.filter(Boolean);
  const config = fc.getConfig();
  return config && config.dns && Array.isArray(config.dns.verificationDomains) && config.dns.verificationDomains.length > 0
    ? config.dns.verificationDomains.filter(Boolean)
    : DEFAULT_VERIFICATION_DOMAINS;
}

function normalizeServerSpec(serverSpec) {
  const raw = typeof serverSpec === 'string' ? serverSpec.trim() : '';
  let host = raw;
  let port = null;

  if (!raw)
    return { raw, host: '', port: null };

  const bracketMatch = raw.match(/^\[([^\]]+)\](?:[:#](\d+))?$/);
  if (bracketMatch) {
    return {
      raw,
      host: bracketMatch[1],
      port: bracketMatch[2] ? Number(bracketMatch[2]) : null
    };
  }

  const hashIndex = raw.lastIndexOf('#');
  if (hashIndex > 0) {
    const portPart = raw.substring(hashIndex + 1);
    if (/^\d+$/.test(portPart)) {
      host = raw.substring(0, hashIndex);
      port = Number(portPart);
      return { raw, host, port };
    }
  }

  if (net.isIP(raw) !== 6) {
    const colonIndex = raw.lastIndexOf(':');
    if (colonIndex > 0) {
      const portPart = raw.substring(colonIndex + 1);
      const hostPart = raw.substring(0, colonIndex);
      if (/^\d+$/.test(portPart) && net.isIP(hostPart) !== 6) {
        host = hostPart;
        port = Number(portPart);
      }
    }
  }

  return { raw, host, port };
}

function buildDigCommand({ host, port, domain, timeout = DEFAULT_TIMEOUT, tries = DEFAULT_TRIES }) {
  const args = [
    'dig',
    port ? `-p ${Number(port)}` : '',
    shellQuote(`@${net.isIP(host) === 6 ? `[${host}]` : host}`),
    shellQuote(domain),
    'A',
    '+short',
    `+time=${Number(timeout)}`,
    `+tries=${Number(tries)}`
  ].filter(Boolean);
  return args.join(' ');
}

function parseAddresses(stdout) {
  return String(stdout || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => net.isIP(line) !== 0);
}

async function probeServer(serverSpec, options = {}) {
  const normalized = typeof serverSpec === 'string' ? normalizeServerSpec(serverSpec) : serverSpec;
  const domains = getVerificationDomains(options.domains);
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  const tries = options.tries || DEFAULT_TRIES;
  const result = {
    server: normalized.raw || normalized.host,
    host: normalized.host,
    port: normalized.port,
    healthy: false,
    domain: null,
    addresses: [],
    error: null
  };

  if (!normalized.host) {
    result.error = 'empty server';
    return result;
  }

  for (const domain of domains) {
    const cmd = buildDigCommand({
      host: normalized.host,
      port: normalized.port,
      domain,
      timeout,
      tries
    });
    try {
      const { stdout, stderr } = await exec(cmd);
      const addresses = parseAddresses(stdout);
      if (addresses.length > 0) {
        result.healthy = true;
        result.domain = domain;
        result.addresses = addresses;
        result.error = null;
        return result;
      }
      result.error = stderr || stdout || `no valid address returned for ${domain}`;
    } catch (err) {
      result.error = [err.stderr, err.stdout, err.message].filter(Boolean).join(' | ');
      log.debug(`Probe failed on ${normalized.raw || normalized.host} for ${domain}`, result.error);
    }
  }

  return result;
}

async function probeLocalServer(host, port, options = {}) {
  return probeServer({
    raw: `${host}${port ? `#${port}` : ''}`,
    host,
    port
  }, options);
}

async function probeServers(servers, options = {}) {
  const results = [];
  for (const server of (Array.isArray(servers) ? servers : [])) {
    results.push(await probeServer(server, options));
  }
  return results;
}

function summarizeProbeResults(results) {
  const probeResults = Array.isArray(results) ? results : [];
  const firstHealthy = probeResults.find(result => result && result.healthy);
  const firstError = probeResults.find(result => result && result.error);
  return {
    healthy: Boolean(firstHealthy),
    firstHealthy,
    firstError,
    error: firstHealthy ? null : (firstError ? (firstError.error !== undefined ? firstError.error : null) : null)
  };
}

module.exports = {
  DEFAULT_TIMEOUT,
  DEFAULT_TRIES,
  DEFAULT_VERIFICATION_DOMAINS,
  buildDigCommand,
  getVerificationDomains,
  normalizeServerSpec,
  parseAddresses,
  probeLocalServer,
  probeServer,
  probeServers,
  summarizeProbeResults
};
