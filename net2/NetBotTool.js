/*    Copyright 2016 Firewalla LLC
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

let log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()

let Promise = require('bluebird');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let async2 = require('async');

let util = require('util');

let FlowAggrTool = require('../net2/FlowAggrTool');
let flowAggrTool = new FlowAggrTool();

let IntelTool = require('../net2/IntelTool');
let intelTool = new IntelTool();

let DestIPFoundHook = require('../hook/DestIPFoundHook');
let destIPFoundHook = new DestIPFoundHook();

let HostTool = require('../net2/HostTool');
let hostTool = new HostTool();

let AppFlowTool = require('../flow/AppFlowTool.js')
let appFlowTool = new AppFlowTool()

let CategoryFlowTool = require('../flow/CategoryFlowTool.js')
let categoryFlowTool = new CategoryFlowTool()

let instance = null;

function toInt(n){ return Math.floor(Number(n)); };


class NetBotTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }

  prepareTopDownloadFlows(json, options) {
    return this._prepareTopFlows(json, "download", options);
  }

  prepareTopUploadFlows(json, options) {
    return this._prepareTopFlows(json, "upload", options);
  }

  prepareCategoryActivitiesFlows(json, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(util.format("Getting category flows between %s and %s", beginString, endString));

    let sumFlowKey = flowAggrTool.getSumFlowKey(undefined, "category", begin, end);

    return async(() => {
      let traffic = await (flowAggrTool.getCategoryActivitySumFlowByKey(sumFlowKey, 50));

      traffic.sort((a, b) => {
        return b.count - a.count;
      });

      traffic.forEach((t) => {
        let mac = t.device;
        let host = await (hostTool.getMACEntry(mac));
        let name = hostTool.getHostname(host);
        t.deviceName = name;
      });

      json.flows.categories = traffic;
    })();
  }

  // app
  prepareAppActivitiesFlows(json, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(util.format("Getting app flows between %s and %s", beginString, endString));

    let sumFlowKey = flowAggrTool.getSumFlowKey(undefined, "app", begin, end);

    return async(() => {
      let traffic = await (flowAggrTool.getAppActivitySumFlowByKey(sumFlowKey, 50));

      traffic.sort((a, b) => {
        return b.count - a.count;
      });

      traffic.forEach((t) => {
        let mac = t.device;
        let host = await (hostTool.getMACEntry(mac));
        let name = hostTool.getHostname(host);
        t.deviceName = name;
      });

      json.flows.apps = traffic;
    })();
  }

  prepareDetailedAppFlowsFromCache(json, options) {
    options = options || {}

    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(`[Cache] Getting app detail flows between ${beginString} and ${endString}`)

    let key = 'appDetails'
//    json.flows[key] = {}
    
    return async(() => {
      let flows = await (flowAggrTool.getCleanedAppActivity(begin, end, options))
      if(flows) {
        json.flows[key] = flows
      }
    })()
  }
  
  prepareDetailedAppFlows(json, options) {
    options = options || {}

    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(`Getting app detail flows between ${beginString} and ${endString}`)

    let key = 'appDetails'
    json.flows[key] = {}

    return async(() => {

      let apps = await (appFlowTool.getApps('*')) // all mac addresses

      let allFlows = {}

      let allPromises = apps.map((app) => {
        allFlows[app] = []

        let macs = await (appFlowTool.getAppMacAddresses(app))

        let promises = macs.map((mac) => {
          return async(() => {
            let appFlows = await (appFlowTool.getAppFlow(mac, app, options))
            appFlows = appFlows.filter((f) => f.duration >= 5) // ignore activities less than 5 seconds
            appFlows.forEach((f) => {
              f.device = mac
            })

            allFlows[app].push.apply(allFlows[app], appFlows)
          })()
        })

        return Promise.all(promises)
          .then(() => {
            allFlows[app].sort((a, b) => {
              return b.ts - a.ts;
            });
          })
      })

      await (Promise.all(allPromises))

      json.flows[key] = allFlows
    })();
  }


  prepareDetailedCategoryFlowsFromCache(json, options) {
    options = options || {}

    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(`[Cache] Getting category detail flows between ${beginString} and ${endString}`)

    let key = 'categoryDetails'
//    json.flows[key] = {}
    
    return async(() => {
      let flows = await (flowAggrTool.getCleanedCategoryActivity(begin, end, options))
      if(flows) {
        json.flows[key] = flows
      }
    })()
  }

  prepareDetailedCategoryFlows(json, options) {
    options = options || {}

    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(`Getting category detail flows between ${beginString} and ${endString}`)

    let key = 'categoryDetails'
    json.flows[key] = {}

    return async(() => {

      let categorys = await (categoryFlowTool.getCategories('*')) // all mac addresses

      // ignore intel category, intel is only for internal logic
      categorys = categorys.filter((x) => x.toLowerCase() !== "intel")

      let allFlows = {}

      let allPromises = categorys.map((category) => {
        allFlows[category] = []

        let macs = await (categoryFlowTool.getCategoryMacAddresses(category))

        let promises = macs.map((mac) => {
          return async(() => {
            let categoryFlows = await (categoryFlowTool.getCategoryFlow(mac, category, options))
            categoryFlows = categoryFlows.filter((f) => f.duration >= 5) // ignore activities less than 5 seconds
            categoryFlows.forEach((f) => {
              f.device = mac
            })

            allFlows[category].push.apply(allFlows[category], categoryFlows)
          })()
        })

        return Promise.all(promises)
          .then(() => {
            allFlows[category].sort((a, b) => {
              return b.ts - a.ts;
            });
          })
      })

      await (Promise.all(allPromises))

      json.flows[key] = allFlows
    })();
  }

  // Top Download/Upload in the entire network
  _prepareTopFlows(json, trafficDirection, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let sumFlowKey = flowAggrTool.getSumFlowKey(undefined, trafficDirection, begin, end);

    return async(() => {
      let traffic = await (flowAggrTool.getTopSumFlowByKey(sumFlowKey, 50));

      traffic.map((f) => {
        f.begin = begin;
        f.end = end;
      })

      let promises = Promise.all(traffic.map((f) => {
        return intelTool.getIntel(f.ip)
        .then((intel) => {
          if(intel) {
            f.country = intel.country;
            f.host = intel.host;
            if(intel.category) {
              f.category = intel.category
            }
            if(intel.app) {
              f.app = intel.app
            }
            return f;
          } else {
            return f;
            // intel not exists in redis, create a new one
            return async(() => {
              try {
                intel = await (destIPFoundHook.processIP(f.ip));
                if (intel) {
                  f.country = intel.country;
                  f.host = intel.host;
                  if(intel.category) {
                    f.category = intel.category
                  }
                  if(intel.app) {
                    f.app = intel.app
                  }
                }
              } catch(err) {
                log.error(`Failed to post-enrich intel ${f.ip}:`, err);
              }
              return f;
            })();
          }
          return f;
        });
      })).then(() => {
        return traffic.sort((a, b) => {
          return b.count - a.count;
        });
      });

      await (promises);

      json.flows[trafficDirection] = traffic
    })();
  }

  // "sumflow:8C:29:37:BF:4A:86:upload:1505073000:1505159400"
  _getTimestamps(sumFlowKey) {
    let pattern = /:([^:]*):([^:]*)$/
    let result = sumFlowKey.match(pattern)
    if(!result) {
      return null
    }

    return {
      begin: toInt(result[1]),
      end: toInt(result[2])
    }
  }

  _prepareTopFlowsForHost(json, mac, trafficDirection, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    json.flows[trafficDirection] = []

    return async(() => {

      let flowKey = null
      
      if(options.queryall) {
        flowKey = await (flowAggrTool.getLastSumFlow(mac, trafficDirection));
      } else {
        flowKey = await (flowAggrTool.getSumFlowKey(mac, trafficDirection, options.begin, options.end))
      }
      
      if (flowKey) {
        let traffic = await (flowAggrTool.getTopSumFlowByKey(flowKey,20)) // get top 20

        let ts = this._getTimestamps(flowKey)

        if(ts) {
          traffic.map((f) => {
            f.begin = ts.begin
            f.end = ts.end
          })
        }


        let promises = Promise.all(traffic.map((f) => {
          return intelTool.getIntel(f.ip)
          .then((intel) => {
            if(intel) {
              f.country = intel.country;
              f.host = intel.host;
              if(intel.category) {
                f.category = intel.category
              }
              if(intel.app) {
                f.app = intel.app
              }
              return f;
            } else {
              return f;

              // intel not exists in redis, create a new one
              return async(() => {
                try {
                  intel = await (destIPFoundHook.processIP(f.ip));
                  if(intel) {
                    f.country = intel.country;
                    f.host = intel.host;
                    if(intel.category) {
                      f.category = intel.category
                    }
                    if(intel.app) {
                      f.app = intel.app
                    }
                  }        
                } catch(err) {
                  log.error(`Failed to post-enrich intel ${f.ip}:`, err);
                }
                
                return f;
              })();
            }
            return f;
          });
        })).then(() => {
          return traffic.sort((a, b) => {
            return b.count - a.count;
          });
        });

        await (promises);

        json.flows[trafficDirection] = traffic
      }
    })();
  }

  prepareTopDownloadFlowsForHost(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }
    return this._prepareTopFlowsForHost(json, mac, "download", options);
  }

  prepareTopUploadFlowsForHost(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    return this._prepareTopFlowsForHost(json, mac, "upload", options);
  }

  prepareDetailedAppFlowsForHost(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    let key = 'appDetails'
    json.flows[key] = {}

    return async(() => {

      let apps = await (appFlowTool.getApps(mac))

      let allFlows = {}

      apps.forEach((app) => {
        let appFlows = await (appFlowTool.getAppFlow(mac, app, options))
        appFlows = appFlows.filter((f) => f.duration >= 5) // ignore activities less than 5 seconds
        allFlows[app] = appFlows
      })

      json.flows[key] = allFlows
    })();
  }
  
  prepareDetailedAppFlowsForHostFromCache(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    options = JSON.parse(JSON.stringify(options))

    let key = 'appDetails'
    json.flows[key] = {}

    return async(() => {

      let apps = await (appFlowTool.getApps(mac))

      let allFlows = {}

      let appFlows = null
      
      if(options.queryall) {
        // need to support queryall too
        let lastAppActivityKey = await (flowAggrTool.getLastAppActivity(mac))
        if(lastAppActivityKey) {
          appFlows = await (flowAggrTool.getCleanedAppActivityByKey(lastAppActivityKey))
        }
      } else {        
        options.mac = mac
        appFlows = await (flowAggrTool.getCleanedAppActivity(options.begin, options.end, options))
      }

      if(appFlows) {
        json.flows[key] = appFlows
      }
    })();
  }

  prepareDetailedCategoryFlowsForHost(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    let key = 'categoryDetails'
    json.flows[key] = {}

    return async(() => {

      let categories = await (categoryFlowTool.getCategories(mac))

      // ignore intel category, intel is only for internal logic
      categories = categories.filter((x) => x.toLowerCase() !== "intel")

      let allFlows = {}

      categories.forEach((category) => {
        let categoryFlows = await (categoryFlowTool.getCategoryFlow(mac, category, options))
        categoryFlows = categoryFlows.filter((f) => f.duration >= 5)
        allFlows[category] = categoryFlows
      })

      json.flows[key] = allFlows
    })();
  }

  prepareDetailedCategoryFlowsForHostFromCache(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }
    
    options = JSON.parse(JSON.stringify(options))
    
    let key = 'categoryDetails'
    json.flows[key] = {}

    return async(() => {

      let categorys = await (categoryFlowTool.getCategories(mac))

      // ignore intel category, intel is only for internal logic
      categorys = categorys.filter((x) => x.toLowerCase() !== "intel")

      let allFlows = {}

      let categoryFlows = null
      
      if(options.queryall) {
        // need to support queryall too
        let lastCategoryActivityKey = await (flowAggrTool.getLastCategoryActivity(mac))
        if(lastCategoryActivityKey) {
          categoryFlows = await (flowAggrTool.getCleanedCategoryActivityByKey(lastCategoryActivityKey))
        }
      } else {
        options.mac = mac
        categoryFlows = await (flowAggrTool.getCleanedCategoryActivity(options.begin, options.end, options))
      }

      if(categoryFlows) {
        json.flows[key] = categoryFlows
      }
    })();
  }


  prepareCategoryActivityFlowsForHost(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    json.flows.categories = [];

    return async(() => {
      let flowKey = await (flowAggrTool.getLastSumFlow(mac, "category"));
      if (flowKey) {
        let traffic = await (flowAggrTool.getCategoryActivitySumFlowByKey(flowKey,20)) // get top 20

        traffic.sort((a,b) => {
          return b.count - a.count;
        });

        traffic.forEach((t) => {
          delete t.device // no need to keep this record since single host data has same device info
        })

        let categoryTraffics = {}

        traffic.forEach((t) => {
          categoryTraffics[t.category] = t
          delete t.category
        })

        json.flows.categories = categoryTraffics;
      }
    })();
  }

  prepareAppActivityFlowsForHost(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    json.flows.apps = [];

    return async(() => {
      let flowKey = await (flowAggrTool.getLastSumFlow(mac, "app"));
      if (flowKey) {
        let traffic = await (flowAggrTool.getAppActivitySumFlowByKey(flowKey,20)) // get top 20

        traffic.sort((a,b) => {
          return b.count - a.count;
        });

        traffic.forEach((t) => {
          delete t.device
        })

        let appTraffics = {}

        traffic.forEach((t) => {
          appTraffics[t.app] = t
          delete t.app
        })

        json.flows.apps = appTraffics;
      }
    })();
  }

}


module.exports = NetBotTool;
