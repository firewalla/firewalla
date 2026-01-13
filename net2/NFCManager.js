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

const rclient = require('../util/redis_manager.js').getRedisClient()
const log = require("./logger.js")(__filename);
const PM2 = require('../alarm/PolicyManager2.js');
const pm2 = new PM2();
const { parseDeviceType } = require('../util/util.js');

const KEY_NFC_REQUEST = "nfc:request";

async function saveRequest(nfcReq) {
    nfcReq.ts = nfcReq.ts || Date.now(); // ts in ms
    log.info(`Create NFC Request`, JSON.stringify(nfcReq));
    await rclient.zaddAsync(KEY_NFC_REQUEST, nfcReq.ts, JSON.stringify(nfcReq));
}

async function _getRequest(ts) {
    const data = await _listRequests({ from: ts, to: ts, all: true });
    return data.length > 0 ? data[0] : null;
}

async function updateRequest(nfcReq, updates) {
    log.info(`Updating NFC Request`, JSON.stringify(nfcReq), JSON.stringify(updates));
    await rclient.zremAsync(KEY_NFC_REQUEST, JSON.stringify(nfcReq));
    const newNfcReq = Object.assign({}, nfcReq, updates);
    const ts = updates.activatedAt || Date.now();
    await rclient.zaddAsync(KEY_NFC_REQUEST, ts, JSON.stringify(newNfcReq));
    return newNfcReq;
}

async function _listRequests(filters = {}) {
    const from = filters.from || 0;
    const to = filters.to || Date.now();
    const data = await rclient.zrangebyscoreAsync(KEY_NFC_REQUEST, from, to);
    try {
        const requests = data.map(item => JSON.parse(item));
        if (filters.all) {
            return requests;
        } else {
            return requests.filter(item => !item.activatedAt);
        }
    } catch (err) {
        log.warn(`Failed to parse NFC request:`, err);
    }
    return [];
}


class NFCManager {
    async newRequest(req) {
        if (!req || !req.pid) {
            log.info(`NFC Request is not valid:`, JSON.stringify(req));
            return;
        }
        const policy = await pm2.getPolicy(req.pid);
        if (!policy) {
            log.info(`NFC Policy not found:`, req.pid);
            return;
        }
        const ts = Date.now();
        const nfcReq = Object.assign({}, { ts }, req);
        await saveRequest(nfcReq);

        nfcReq.policy = policy;
        return nfcReq;
    }

    async listRequests(filters = {}) {
        const result = await _listRequests(filters);
        return result;
    }

    async getRequest(ts) {
        const result = await _getRequest(ts);
        if (result && result.pid) {
            const policy = await pm2.getPolicy(result.pid);
            result.policy = policy;
        }
        return result;
    }

    async _updatePolicy(nfcReq) {
        const policy = await pm2.getPolicy(nfcReq.pid);
        log.info(`Updating policy via nfc request${nfcReq.ts} with:`, JSON.stringify(policy));
        if (!policy) {
            log.info(`NFC Policy not found:`, JSON.stringify(nfcReq));
            return;
        }
        if (nfcReq.action == "pause") {
            log.info(`NFC Request ${nfcReq.ts} is pausing policy ${nfcReq.pid}:`, JSON.stringify(nfcReq));
            policy.disabled = 1;
            // set duration if provided
            if (nfcReq.duration) {
                policy.idleTs = Date.now() / 1000 + nfcReq.duration;
            } else {
                policy.idleTs = null;
            }

        } else if (nfcReq.action == "resume") {
            log.info(`NFC Request ${nfcReq.ts} is resuming policy ${nfcReq.pid}:`, JSON.stringify(nfcReq));
            policy.disabled = 0;
            policy.idleTs = null;
        } else {
            log.info(`NFC Request ${nfcReq.ts} is not valid:`, JSON.stringify(nfcReq));
            return;
        }
        await pm2.updatePolicyAsync(policy);
        return policy;
    }

    async activateRequest(req) {
        try {
            if (!req || !req.ts) {
                log.info(`NFC Request is not valid:`, JSON.stringify(req));
                return;
            }
            const nfcReq = await _getRequest(req.ts);
            if (!nfcReq) {
                log.info(`No available NFC Request not found at timestamp ${req.ts}`);
                return;
            }
            log.info(`NFC Request:`, JSON.stringify(nfcReq));
            if (!nfcReq.pid) {
                log.info(`NFC Request ${req.ts} has no policy:`, JSON.stringify(nfcReq));
                return;
            }
            if (nfcReq.activatedAt) {
                log.info(`NFC Request ${req.ts} is already activated:`, JSON.stringify(nfcReq));
                return nfcReq;
            }
            let policy = null;
            if (!nfcReq.ignore) {
                policy = await this._updatePolicy(nfcReq);
            }

            const updates = { activatedAt: Date.now() };
            if (req.ignore) {
                updates.ignore = req.ignore;
            }
            const newNfcReq = await updateRequest(nfcReq, updates);
            if (policy) {
                newNfcReq.policy = policy;
            }
            return newNfcReq;
        } catch (err) {
            log.error(`Failed to activate NFC Request ${req.ts}:`, err);
        }
    }

    getNotifyArgs(req) {
        const titleLocalArgs = [];
        if (req.device) {
            titleLocalArgs.push(parseDeviceType(req.device));
        } else {
            titleLocalArgs.push("Unknown Device");
        }
        let target = "";
        if (req.policy && req.policy.app_name) {
            target = req.policy.app_name;
        }
        if (!target && req.policy && req.policy.target) {
            target = req.policy.target;
        }
        if (!target) {
            target = "Unknown App";
        }
        titleLocalArgs.push(target);
        titleLocalArgs.push(Math.round(req.duration / 60) || 0);
        titleLocalArgs.push(req.ts);
        return titleLocalArgs;
    }
}

module.exports = new NFCManager()
