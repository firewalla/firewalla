/*    Copyright 2016-2025 Firewalla Inc.
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

'use strict'

const rclient = require('../util/redis_manager.js').getRedisClient();
const log = require('../net2/logger.js')(__filename);

const API_STATS_KEY_EXCLUDE_LIST = [
    "cmd:ping:0.0.0.0",
];

// KEYS[1] = 'api:hash' (the hash)
// KEYS[2] = 'api:id' (the counter)
// ARGV[1] = '{mtype}:{item}:{target}'
const LUA_GET_API_ID_SCRIPT = `
  local apiId = redis.call('HGET', KEYS[1], ARGV[1]);
  if apiId then return apiId end;
  apiId = redis.call('INCR', KEYS[2]);
  local newSet = redis.call('HSETNX', KEYS[1], ARGV[1], apiId);
  if newSet == 0 then return redis.call('HGET', KEYS[1], ARGV[1]);end
  return apiId
`;

let getApiIdSha;
let getApiIdShaPromise;

async function getApiId(apiStr) {
    if (!getApiIdSha) {
        if (!getApiIdShaPromise) {
            getApiIdShaPromise = rclient.scriptAsync('LOAD', LUA_GET_API_ID_SCRIPT).then(sha => {
                getApiIdSha = sha;
                return sha;
            });
        }
        await getApiIdShaPromise;
    }

    try {
        const apiId = await rclient.evalshaAsync(getApiIdSha, 2, 'api:hash', 'api:id', apiStr);
        return apiId;
    } catch (err) {
        log.error(`Failed to get API ID for ${apiStr}: ${err}`);
        return null;
    }
}

// avoid parallel api calls at the same time
function random(min = 2, max = 9) {
    return Math.random().toString(36).substring(min, max);
}

// ts in ms
async function logApiStats(key, apiStr, ts) {
    try {
        if (!key || key == undefined || key == "undefined") return;
        const apiId = await getApiId(apiStr);
        if (!apiId) {
            return;
        }
        await rclient.zaddAsync(`api:stats:${key}`, ts, `${apiId}:${random()}`);
    } catch (err) {
        log.info(`Failed to log API stats for ${apiStr}: ${err}`);
    }
}

async function getApiStats(recent = 3600, topEid = 5, topApi = 3) {
    log.debug(`Getting API stats for recent ${recent} seconds, top ${topEid} EIDs, top ${topApi} APIs`);
    // get all api:stats:* keys
    const keys = await rclient.keysAsync('api:stats:*');
    if (keys.length === 0) {
        return {};
    }
    const apiHash = await rclient.hgetallAsync('api:hash');
    const apiMappings = Object.fromEntries(Object.entries(apiHash).map(([k, v]) => [v, k]));

    const now = Date.now();
    const apiStats = {}
    for (const key of keys) {
        const values = await rclient.zrangebyscoreAsync(key, now - recent * 1000, '+inf');
        const records = values.map(x => x.split(':')[0]);
        const apiIds = records.reduce((acc, apiId) => { acc[apiId] = (acc[apiId] || 0) + 1; return acc; }, {});
        const apiStrs = Object.fromEntries(Object.entries(apiIds).map(([apiId, count]) => [apiMappings[apiId] || apiId, count]));
        const eid = key.replace('api:stats:', '');
        apiStats[eid] = apiStrs;
    }
    const topSummary = getTopSummary(apiStats, topEid, topApi);
    return { apiStats: topSummary };
}

function getTopSummary(apiStats, topEid = 5, topApi = 3) {
    const summary = Object.fromEntries(Object.entries(apiStats).map(([eid, stats]) => [eid, Object.values(stats).reduce((sum, count) => sum + count, 0)]));
    // sort by value descending and get the top 5
    const top5Eids = Object.fromEntries(Object.entries(summary).sort((a, b) => b[1] - a[1]).slice(0, topEid));
    // get top 5 eids apiStats
    const top5Data = Object.entries(apiStats).filter(([eid]) => top5Eids[eid]).map(([eid, stats]) => [eid, stats]);
    const top5ApiStats = {};
    // apiStats only keep top 5 apis
    for (const apiStat of top5Data) {
        const [eid, stats] = apiStat;
        // sort by value descending and get the top 3 APIs
        top5ApiStats[eid] = Object.fromEntries(Object.entries(stats).sort((a, b) => b[1] - a[1]).slice(0, topApi));
    }
    return top5ApiStats;
}

module.exports = {
    logApiStats,
    getApiStats,
    API_STATS_KEY_EXCLUDE_LIST
};


