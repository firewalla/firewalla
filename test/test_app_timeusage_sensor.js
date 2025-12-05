
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

let chai = require('chai');
let expect = chai.expect;
const DomainTrie = require('../util/DomainTrie.js');
const AppTimeUsageSensor = require('../sensor/AppTimeUsageSensor.js');
const e = require('express');


describe('Test process AppTimeUsageSensor', function () {
  this.timeout(3000);

  before(() => {
    this.plugin = new AppTimeUsageSensor({});

  });


  it('should process Domain With Port correctly', async () => {
    this.plugin.appConfs = {
      "Roblox": {
        "category": "games",
        "displayName": "Roblox",
        "includedDomains": [
          {
            "domain": "gamejoin.roblox.com",
            "portInfo": [
              {
                "proto": "tcp",
                "start": "443",
                "end": "443"
              }
            ],
            "occupyMins": 3,
            "lingerMins": 15,
            "minsThreshold": 1,
            "bytesThreshold": 1024
          }],
        "excludedDomains": []
      }
    }
    this.plugin.rebuildTrie();

    const flow = {
      "ts": 1756908607.07, "_ts": 1756908667.099, "sh": "192.168.45.154", "dh": "128.116.63.3", "ob": 433, "rb": 647, "ct": 1, "fd": "in", "lh": "192.168.45.154",
      "intf": "9cb0dba3-4f75-4408-9728-9cb6b972163f", "du": 20.45, "pr": "tcp", "uids": [], "ltype": "mac", "oIntf": "aadf0123",
      "af": { "gamejoin.roblox.com": { "proto": "ssl", "ip": "128.116.63.3" } }, "dTags": ["3"], "tags": ["40"], "dstTags": {}, "sp": [50251], "dp": 443,
      "mac": "56:30:BA:F0:11:9A", "ip": "128.116.63.3", "host": "gamejoin.roblox.com", "from": "flow", "retryCount": 0,
      "intel": {
        "ip": "128.116.63.3", "host": "gamejoin.roblox.com", "dnsHost": "ecsv2.roblox.com", "sslHost": "ecsv2.roblox.com",
        "s": "0", "t": "25", "cc": "[]", "v": "1", "originIP": "gamejoin.roblox.com", "e": "604800", "category": "games", "isOriginIPAPattern": true, "updateTime": "1756908668.493"
      }
    };
    const result = this.plugin.lookupAppMatch(flow);
    expect(result.length).to.be.equal(2);
    expect(result[0].app).to.be.equal("Roblox");
    expect(result[0].occupyMins).to.be.equal(3);
    expect(result[0].lingerMins).to.be.equal(15);
    expect(result[0].minsThreshold).to.be.equal(1);
    expect(result[0].bytesThreshold).to.be.equal(1024);
    expect(result[1].app).to.be.equal("internet");
  });


  it('should process wildcard Domain With Port correctly', async () => {
    this.plugin.appConfs = {
      "Roblox": {
        "category": "games",
        "displayName": "Roblox",
        "includedDomains": [
          {
            "domain": "*.roblox.com",
            "portInfo": [
              {
                "proto": "tcp",
                "start": "443",
                "end": "443"
              }
            ],
            "occupyMins": 3,
            "lingerMins": 15,
            "minsThreshold": 1,
            "bytesThreshold": 1024
          }],
        "excludedDomains": []
      }
    }
    this.plugin.rebuildTrie();

    const flow = {
      "ts": 1756908607.07, "_ts": 1756908667.099, "sh": "192.168.45.154", "dh": "128.116.63.3", "ob": 433, "rb": 647, "ct": 1, "fd": "in", "lh": "192.168.45.154",
      "intf": "9cb0dba3-4f75-4408-9728-9cb6b972163f", "du": 20.45, "pr": "tcp", "uids": [], "ltype": "mac", "oIntf": "aadf0123",
      "af": { "gamejoin.roblox.com": { "proto": "ssl", "ip": "128.116.63.3" } }, "dTags": ["3"], "tags": ["40"], "dstTags": {}, "sp": [50251], "dp": 443,
      "mac": "56:30:BA:F0:11:9A", "ip": "128.116.63.3", "host": "gamejoin.roblox.com", "from": "flow", "retryCount": 0,
      "intel": {
        "ip": "128.116.63.3", "host": "gamejoin.roblox.com", "dnsHost": "ecsv2.roblox.com", "sslHost": "ecsv2.roblox.com",
        "s": "0", "t": "25", "cc": "[]", "v": "1", "originIP": "gamejoin.roblox.com", "e": "604800", "category": "games", "isOriginIPAPattern": true, "updateTime": "1756908668.493"
      }
    };
    const result = this.plugin.lookupAppMatch(flow);
    expect(result.length).to.be.equal(2);
    expect(result[0].app).to.be.equal("Roblox");
    expect(result[0].occupyMins).to.be.equal(3);
    expect(result[0].lingerMins).to.be.equal(15);
    expect(result[0].minsThreshold).to.be.equal(1);
    expect(result[0].bytesThreshold).to.be.equal(1024);
    expect(result[1].app).to.be.equal("internet");
  });


  it('should match the correct Port range correctly', async () => {
    this.plugin.appConfs = {
      "Roblox": {
        "category": "games",
        "displayName": "Roblox",
        "includedDomains": [
          {
            "domain": "*.roblox.com",
            "portInfo": [
              {
                "proto": "tcp",
                "start": "440",
                "end": "443"
              }
            ],
            "occupyMins": 3,
            "lingerMins": 15,
            "minsThreshold": 1,
            "bytesThreshold": 1024
          },
          {
            "domain": "gamejoin.roblox.com",
            "portInfo": [
              {
                "proto": "tcp",
                "start": "440",
                "end": "443"
              }
            ],
            "occupyMins": 13,
            "lingerMins": 10,
            "minsThreshold": 1,
            "bytesThreshold": 1024
          }],
        "excludedDomains": []
      }
    }
    this.plugin.rebuildTrie();

    const flow = {
      "ts": 1756908607.07, "_ts": 1756908667.099, "sh": "192.168.45.154", "dh": "128.116.63.3", "ob": 433, "rb": 647, "ct": 1, "fd": "in", "lh": "192.168.45.154",
      "intf": "9cb0dba3-4f75-4408-9728-9cb6b972163f", "du": 20.45, "pr": "tcp", "uids": [], "ltype": "mac", "oIntf": "aadf0123",
      "af": { "gamejoin.roblox.com": { "proto": "ssl", "ip": "128.116.63.3" } }, "dTags": ["3"], "tags": ["40"], "dstTags": {}, "sp": [50251], "dp": 443,
      "mac": "56:30:BA:F0:11:9A", "ip": "128.116.63.3", "host": "gamejoin.roblox.com", "from": "flow", "retryCount": 0,
      "intel": {
        "ip": "128.116.63.3", "host": "gamejoin.roblox.com", "dnsHost": "ecsv2.roblox.com", "sslHost": "ecsv2.roblox.com",
        "s": "0", "t": "25", "cc": "[]", "v": "1", "originIP": "gamejoin.roblox.com", "e": "604800", "category": "games", "isOriginIPAPattern": true, "updateTime": "1756908668.493"
      }
    };
    const result = this.plugin.lookupAppMatch(flow);
    //domainTier will only return the first matched entry. even if the portinfo of it is not matched by the flow, the other entries will be skipped.
    expect(result.length).to.be.equal(2);     
    expect(result[0].app).to.be.equal("Roblox");
    expect(result[0].occupyMins).to.be.equal(13);
    expect(result[0].lingerMins).to.be.equal(10);
    expect(result[0].minsThreshold).to.be.equal(1);
    expect(result[0].bytesThreshold).to.be.equal(1024);
    expect(result[1].app).to.be.equal("internet");
  });

  it('should match the correct facebook flow correctly', async () => {
    this.plugin.appConfs = {
      "facebook": {
        "category": "social",
        "displayName": "Facebook",
        "includedDomains": [
          {
            "domain": "chat-e2ee*.facebook.com",
            "portInfo": [
              {
                "start": 5222,
                "end": 5222
              }
            ],
            "occupyMins": 1,
            "lingerMins": 3,
            "minsThreshold": 1,
            "bytesThreshold": 5120
          }
        ],
        "intelDomains": [
          "*.facebook.com",
          "*.fbcdn.net"
        ],
        "excludedDomains": [
          "static.xx.fbcdn.net"
        ]
      }
    }
    this.plugin.rebuildTrie();

    const flow = {
        "ts": 1757651024.73, "_ts": 1757651145.385, "sh": "192.168.159.4", "dh": "157.240.11.30", "ob": 50230,
        "rb": 82682, "ct": 1, "fd": "in", "lh": "192.168.159.4", "intf": "ff670d62-752d-4b74-87b0-108ef7d945d2", "du": 117.85, "pr": "tcp",
        "uids": [], "ltype": "mac", "oIntf": "3a57dadb", "af": { "chat-e2ee.c10r.facebook.com": { "proto": "dns", "ip": "157.240.11.30" } }, "dTags": ["50"],
        "dstTags": {}, "sp": [50642], "dp": 5222, "mac": "7A:3C:EB:12:DF:57", "ip": "157.240.11.30", "host": "chat-e2ee.c10r.facebook.com", "from": "flow",
        "intel": {
          "ip": "157.240.11.30", "host": "chat-e2ee.c10r.facebook.com", "s": "0", "t": "35", "cc": "[]", "v": "1", "originIP": "facebook.com", "e": "604800",
          "category": "social", "isOriginIPAPattern": true, "updateTime": "1757651146.856"
        }
    };
    const result = this.plugin.lookupAppMatch(flow);
    //domainTier will only return the first matched entry. even if the portinfo of it is not matched by the flow, the other entries will be skipped.
    expect(result.length).to.be.equal(2);     
    expect(result[0].app).to.be.equal("facebook");
    expect(result[0].occupyMins).to.be.equal(1);
    expect(result[0].lingerMins).to.be.equal(3);
    expect(result[0].minsThreshold).to.be.equal(1);
    expect(result[0].bytesThreshold).to.be.equal(5120);
    expect(result[1].app).to.be.equal("internet");
  });


  it('should process CIDRv4 With Port correctly', async () => {
    this.plugin.appConfs = {
      "Roblox": {
        "category": "games",
        "displayName": "Roblox",
        "includedDomains": [
          {
            "cidr": "128.116.0.0/17",
            "portInfo": [
              {
                "start": "8080",
                "end": "8088"
              },
              {
                "proto": "tcp",
                "start": "443",
                "end": "443"
              },
              {
                "proto": "udp",
                "start": "49152",
                "end": "65535"
              }
            ],
            "occupyMins": 1,
            "lingerMins": 5,
            "minsThreshold": 1,
            "bytesThreshold": 1048576
          }],
        "excludedDomains": []
      }
    }
    this.plugin.rebuildTrie();

    const flow = {
      "ts": 1756908607.07, "_ts": 1756908667.099, "sh": "192.168.45.154", "dh": "128.116.63.3", "ob": 2033700, "rb": 64701, "ct": 1,
      "fd": "in", "lh": "192.168.45.154", "intf": "9cb0dba3-4f75-4408-9728-9cb6b972163f", "du": 20.45, "pr": "udp", "uids": [], "ltype": "mac", "oIntf": "aadf0123",
      "af": { "clientsettings.roblox.com": { "proto": "ssl", "ip": "128.116.63.3" } }, "dTags": ["3"], "tags": ["40"], "dstTags": {}, "sp": [50251],
      "dp": 49999, "mac": "56:30:BA:F0:11:9A", "ip": "128.116.63.3", "host": "clientsettings.roblox.com", "from": "flow", "retryCount": 0,
      "intel": {
        "ip": "128.116.63.3", "host": "clientsettings.roblox.com", "dnsHost": "ecsv2.roblox.com", "sslHost": "ecsv2.roblox.com",
        "s": "0", "t": "25", "cc": "[]", "v": "1", "originIP": "clientsettings.roblox.com", "e": "604800", "category": "games", "isOriginIPAPattern": true, "updateTime": "1756908668.493"
      }
    };
    const result = this.plugin.lookupAppMatch(flow);
    expect(result.length).to.be.equal(2);
    expect(result[0].app).to.be.equal("Roblox");
    expect(result[0].occupyMins).to.be.equal(1);
    expect(result[0].lingerMins).to.be.equal(5);
    expect(result[0].minsThreshold).to.be.equal(1);
    expect(result[0].bytesThreshold).to.be.equal(1048576);
  });

  it('should match the more precise CIDRv4 correctly', async () => {
    this.plugin.appConfs = {
      "Roblox": {
        "category": "games",
        "displayName": "Roblox",
        "includedDomains": [
          {
            "cidr": "128.116.0.0/16",
            "portInfo": [
              {
                "proto": "udp",
                "start": "49152",
                "end": "65535"
              }
            ],
            "occupyMins": 1,
            "lingerMins": 5,
            "minsThreshold": 1,
            "bytesThreshold": 1048576
          },
          {
            "cidr": "128.116.0.0/17",
            "portInfo": [
              {
                "proto": "udp",
                "start": "49152",
                "end": "65535"
              }
            ],
            "occupyMins": 2,
            "lingerMins": 10,
            "minsThreshold": 10,
            "bytesThreshold": 1048576
          }
        ],
        "excludedDomains": []
      }
    }
    this.plugin.rebuildTrie();

    const flow = {
      "ts": 1756908607.07, "_ts": 1756908667.099, "sh": "192.168.45.154", "dh": "128.116.63.3", "ob": 2033700, "rb": 64701, "ct": 1,
      "fd": "in", "lh": "192.168.45.154", "intf": "9cb0dba3-4f75-4408-9728-9cb6b972163f", "du": 20.45, "pr": "udp", "uids": [], "ltype": "mac", "oIntf": "aadf0123",
      "af": { "clientsettings.roblox.com": { "proto": "ssl", "ip": "128.116.63.3" } }, "dTags": ["3"], "tags": ["40"], "dstTags": {}, "sp": [50251],
      "dp": 49999, "mac": "56:30:BA:F0:11:9A", "ip": "128.116.63.3", "host": "clientsettings.roblox.com", "from": "flow", "retryCount": 0,
      "intel": {
        "ip": "128.116.63.3", "host": "clientsettings.roblox.com", "dnsHost": "ecsv2.roblox.com", "sslHost": "ecsv2.roblox.com",
        "s": "0", "t": "25", "cc": "[]", "v": "1", "originIP": "clientsettings.roblox.com", "e": "604800", "category": "games", "isOriginIPAPattern": true, "updateTime": "1756908668.493"
      }
    };
    const result = this.plugin.lookupAppMatch(flow);
    expect(result.length).to.be.equal(2);
    expect(result[0].app).to.be.equal("Roblox");
    expect(result[0].occupyMins).to.be.equal(2);
    expect(result[0].lingerMins).to.be.equal(10);
    expect(result[0].minsThreshold).to.be.equal(10);
    expect(result[0].bytesThreshold).to.be.equal(1048576);
  });

  it('should process CIDRv6 With Port correctly', async () => {
    this.plugin.appConfs = {
      "Roblox": {
        "category": "games",
        "displayName": "Roblox",
        "includedDomains": [
          {
            "cidr": "2000:0:0:1::/64",
            "portInfo": [
              {
                "start": "8080",
                "end": "8088"
              },
              {
                "proto": "tcp",
                "start": "443",
                "end": "443"
              },
              {
                "proto": "udp",
                "start": "49152",
                "end": "65535"
              }
            ],
            "occupyMins": 1,
            "lingerMins": 5,
            "minsThreshold": 1,
            "bytesThreshold": 1048576
          }],
        "excludedDomains": []
      }
    }
    this.plugin.rebuildTrie();

    const flow = {
      "ts": 1756908607.07, "_ts": 1756908667.099, "sh": "192.168.45.154", "dh": "2000:0:0:1::1", "ob": 2033700, "rb": 64701, "ct": 1,
      "fd": "in", "lh": "192.168.45.154", "intf": "9cb0dba3-4f75-4408-9728-9cb6b972163f", "du": 20.45, "pr": "udp", "uids": [], "ltype": "mac", "oIntf": "aadf0123",
      "af": { "clientsettings.roblox.com": { "proto": "ssl", "ip": "2000:0:0:1::1" } }, "dTags": ["3"], "tags": ["40"], "dstTags": {}, "sp": [50251],
      "dp": 49999, "mac": "56:30:BA:F0:11:9A", "ip": "2000:0:0:1::1", "host": "clientsettings.roblox.com", "from": "flow", "retryCount": 0,
      "intel": {
        "ip": "2000:0:0:1::1", "host": "clientsettings.roblox.com", "dnsHost": "ecsv2.roblox.com", "sslHost": "ecsv2.roblox.com",
        "s": "0", "t": "25", "cc": "[]", "v": "1", "originIP": "clientsettings.roblox.com", "e": "604800", "category": "games", "isOriginIPAPattern": true, "updateTime": "1756908668.493"
      }
    };
    const result = this.plugin.lookupAppMatch(flow);
    expect(result.length).to.be.equal(2);
    expect(result[0].app).to.be.equal("Roblox");
    expect(result[0].occupyMins).to.be.equal(1);
    expect(result[0].lingerMins).to.be.equal(5);
    expect(result[0].minsThreshold).to.be.equal(1);
    expect(result[0].bytesThreshold).to.be.equal(1048576);
  });


  it('should match the more precise CIDRv6 correctly', async () => {
    this.plugin.appConfs = {
      "Roblox": {
        "category": "games",
        "displayName": "Roblox",
        "includedDomains": [
          {
            "cidr": "2000:0:0:1::/48",
            "portInfo": [
              {
                "proto": "udp",
                "start": "49152",
                "end": "65535"
              }
            ],
            "occupyMins": 1,
            "lingerMins": 5,
            "minsThreshold": 1,
            "bytesThreshold": 1048576
          },
          {
            "cidr": "2000:0:0:1::/64",
            "portInfo": [
              {
                "proto": "udp",
                "start": "49152",
                "end": "65535"
              }
            ],
            "occupyMins": 2,
            "lingerMins": 10,
            "minsThreshold": 2,
            "bytesThreshold": 1048576
          }
        ],
        "excludedDomains": []
      }
    }
    this.plugin.rebuildTrie();

    const flow = {
      "ts": 1756908607.07, "_ts": 1756908667.099, "sh": "192.168.45.154", "dh": "2000:0:0:1::1", "ob": 2033700, "rb": 64701, "ct": 1,
      "fd": "in", "lh": "192.168.45.154", "intf": "9cb0dba3-4f75-4408-9728-9cb6b972163f", "du": 20.45, "pr": "udp", "uids": [], "ltype": "mac", "oIntf": "aadf0123",
      "af": { "clientsettings.roblox.com": { "proto": "ssl", "ip": "2000:0:0:1::1" } }, "dTags": ["3"], "tags": ["40"], "dstTags": {}, "sp": [50251],
      "dp": 49999, "mac": "56:30:BA:F0:11:9A", "ip": "2000:0:0:1::1", "host": "clientsettings.roblox.com", "from": "flow", "retryCount": 0,
      "intel": {
        "ip": "2000:0:0:1::1", "host": "clientsettings.roblox.com", "dnsHost": "ecsv2.roblox.com", "sslHost": "ecsv2.roblox.com",
        "s": "0", "t": "25", "cc": "[]", "v": "1", "originIP": "clientsettings.roblox.com", "e": "604800", "category": "games", "isOriginIPAPattern": true, "updateTime": "1756908668.493"
      }
    };
    const result = this.plugin.lookupAppMatch(flow);
    expect(result.length).to.be.equal(2);
    expect(result[0].app).to.be.equal("Roblox");
    expect(result[0].occupyMins).to.be.equal(2);
    expect(result[0].lingerMins).to.be.equal(10);
    expect(result[0].minsThreshold).to.be.equal(2);
    expect(result[0].bytesThreshold).to.be.equal(1048576);
  });


  it('should match the sigId correctly', async () => {
    this.plugin.appConfs = {
      "Roblox": {
        "category": "games",
        "displayName": "Roblox",
        "includedDomains": [
          {
            "cidr": "128.116.0.0/17",
            "portInfo": [
              {
                "start": "8080",
                "end": "8088"
              },
              {
                "proto": "tcp",
                "start": "443",
                "end": "443"
              },
              {
                "proto": "udp",
                "start": "49152",
                "end": "65535"
              }
            ],
            "occupyMins": 1,
            "lingerMins": 5,
            "minsThreshold": 1,
            "bytesThreshold": 1024
          },
          {
            "sigId": "roblox-sig",
            "occupyMins": 1,
            "lingerMins": 5,
            "minsThreshold": 1,
            "bytesThreshold": 1024
          }
        ],
        "excludedDomains": []
      }
    }
    this.plugin.rebuildTrie();

    const flow = {
      "ts": 1759200147.93, "_ts": 1759200274.882, "sh": "192.168.159.239", "dh": "54.245.196.33", "ob": 566339, "rb": 17877850, "ct": 1, "fd": "in", "lh": "192.168.159.239",
      "intf": "ff670d62-752d-4b74-87b0-108ef7d945d2", "du": 119.97, "pr": "udp", "uids": [], "ltype": "mac", "oIntf": "924acbb9", "af": {}, "rpid": 388,
      "dpid": 406, "dTags": ["49"], "dstTags": {}, "sp": [65137], "dp": 61491, "sigs": ["roblox-sig-reverse", "roblox-sig"], "mac": "66:6E:7A:8D:80:ED",
      "ip": "54.245.196.33", "host": null, "from": "flow", "intel": { "updateTime": "1759133337.844", "ip": "128.116.53.33" }
    };
    const result = this.plugin.lookupAppMatch(flow);
    expect(result.length).to.be.equal(2);
    expect(result[0].app).to.be.equal("Roblox");
    expect(result[0].occupyMins).to.be.equal(1);
    expect(result[0].lingerMins).to.be.equal(5);
    expect(result[0].minsThreshold).to.be.equal(1);
    expect(result[0].bytesThreshold).to.be.equal(1024);
  });



});
