/*    Copyright 2016-2021 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename)
const Promise = require('bluebird')

let instance = null

class ExtensionManager {
  constructor() {
    if(!instance) {
      this.extensions = {}
      this.hooks = {}
      this.onGets = {}
      this.onSets = {}
      this.onCmds = {};
      this.cmdMap = {}
      instance = this
    }
    return instance
  }

  registerExtension(name, obj, hooks) {
    this.extensions[name] = obj
    this.hooks[name] = hooks
  }

  getExtension(name) {
    return this.extensions[name]
  }

  hasExtension(name) {
    return this.extensions[name] != null
  }

  getHook(extName, hookName) {
    return this.hooks[extName][hookName].bind(this.extensions[extName])
  }

  hasGet(key) {
    return this.onGets[key] != null
  }

  hasSet(key) {
    return this.onSets[key] != null
  }

  hasCmd(key) {
    return this.onCmds[key] != null;
  }

  // callback should return promise
  onGet(key, callback) {
    this.cmdMap[key] = 1;
    this.onGets[key] = callback
  }

  // callback should return promise
  onSet(key, callback) {
    this.cmdMap[key] = 1;
    this.onSets[key] = callback
  }

  // callback should return promise
  onCmd(key, callback) {
    this.cmdMap[key] = 1;
    this.onCmds[key] = callback;
  }

  get(key, msg, data) {
    log.verbose('get', key, msg, data)
    if(this.hasGet(key)) {
      return this.onGets[key](msg, data)
    }

    return Promise.reject(new Error("no such key:" + key))
  }

  set(key, msg, data) {
    log.verbose('set', key, msg, data)
    if(this.hasSet(key)){
      return this.onSets[key](msg, data)
    }

    return Promise.reject(new Error("no such key:" + key))
  }

  cmd(key, msg, data) {
    log.verbose('cmd', key, msg, data)
    if(this.hasCmd(key)){
      return this.onCmds[key](msg, data)
    }

    return Promise.reject(new Error("no such key:" + key))
  }

  getAllCmdKeys() {
    return Object.keys(this.cmdMap);
  }
}

module.exports = new ExtensionManager()
