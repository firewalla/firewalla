const log = require("../net2/logger.js")(__filename);
const rp = require('request-promise');
const bone = require("../lib/Bone.js");

class IpInfo {

  async get(ip) {
    const options = {
      uri: "http://ipinfo.io/" + ip,
      method: 'GET',
      family: 4,
      timeout: 6000, // ms
    };

    let body;
    let result = null;
    try {
      body = await rp(options);
    } catch (err) {
      log.error("Error while requesting", options.uri, err.code, err.message, err.stack);
      return null;
    }

    try {
      result = JSON.parse(body);
    } catch (err) {
      log.error("Error when parse body:", body, err);
    }

    log.info("ipInfo from ipinfo is:", result);
    return result;
  }

  async getFromBone(ip) {
    let result = await bone.intelFinger(ip);
    if (result) {
      log.info("ipInfo from bone is:", result.ipinfo);
      return result.ipinfo;
    }
    log.info("ipInfo from bone is:", null);
    return null;
  }
  
}

module.exports = new IpInfo();
