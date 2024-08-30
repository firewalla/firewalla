/*    Copyright 2016-2023 Firewalla Inc.
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

const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const pclient = require('../util/redis_manager.js').getPublishClient();

const _ = require('lodash')

/*
 * Channels
 *
 *   DiscoveryEvent
 *     -> Scan:Done
 *     -> DiscoveryStart
 *
 */

var instances = {};

module.exports = class {
  constructor(loglevel, instanceId = 'default', throttle = 1) {
    let instance = null;
    instance = instances[instanceId];
    if (instance == null) {
      instance = this;
      instances[instanceId] = instance;
      this.callbacks = {};
      this.throttle = throttle;
      this.sending = false;
      sclient.on('message', async (channel, message) => {
        if (!this.callbacks[channel]) return
        try {
          const m = JSON.parse(message);
          const {type, id, msg} = m
          log.debug('Reciving Msg:', m);
          let notified = 0;
          let cbs = []
          if ( id && this.callbacks[channel][type + '.' + id]) {
            cbs = this.callbacks[channel][type + '.' + id];
          }
          if (this.callbacks[channel][type]) {
            cbs.push(... this.callbacks[channel][type])
          }
          for (const cb of cbs) try {
            // await no matter it's sync or async so error from callback would be caught here
            await cb(channel, type, id, msg)
            notified += 1;
          } catch(err) {
            log.error('Error on', channel, type, id, msg)
            log.error(err)
          }
          log.debug('Notified ', notified);
        } catch (err) {
          log.debug("Error to process message:", channel, message, "err:", err);
          // ignore any non-JSON messages
        }
      });
    }
    return instance;
  }

  publish(channel, type, id, msg) {
    if (_.isObject(id) || !msg) {
      msg = id
      id = undefined
    }
    const o = { type, id, msg };
    log.debug('MBus:Publish', channel, o);
    pclient.publish(channel, JSON.stringify(o));
  }

  publishCompressed(channel, type, id, msg) {
    if (this.sending == true) {
      log.info('suppressing message:', channel, type, id, msg);
      return;
    }

    this.sending = true;

    setTimeout(() => {
      this.sending = false;
      this.publish(channel, type, id, msg);
    }, this.throttle * 1000);
  }

  // this is NOT one-time subscribe but one-instance subsribe
  subscribeOnce(channel, type, id, callback) {
    this.subscribe(channel, type, id, callback, true, true)
  }

  // unsubscribe && once doesn't make sense here
  subscribe(channel, type, id, callback, subscribe = true, once = false) {
    if (!this.callbacks[channel]) {
      if (subscribe) {
        sclient.subscribe(channel)
        this.callbacks[channel] = {}
      } else
        return
    }

    if (id instanceof Function) {
      callback = id
      id = undefined
    }
    const key = id ? type+'.'+id : type

    if (once && this.callbacks[channel][key]) {
      return; // already subscribed...
    }

    if (subscribe) {
      if (!this.callbacks[channel][key]) {
        this.callbacks[channel][key] = [];
      }
      this.callbacks[channel][key].push(callback);
    }
    else {
      if (callback && this.callbacks[channel][key]) {
        this.callbacks[channel][key] = this.callbacks[channel][key].filter(f => f != callback)
        if (!this.callbacks[channel][key].length)
          delete this.callbacks[channel][key]
      } else
        delete this.callbacks[channel][key]
    }
  }

  unsubscribe(channel, type, id, callback) {
    this.subscribe(channel, type, id, callback, false)
  }
};

