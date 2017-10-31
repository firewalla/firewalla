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

const log = require('../net2/logger.js')(__filename)

let instance = null

class ExtensionManager {
  constructor() {
    if(!instance) {
      this.extensions = {}
      this.hooks = {}
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
    return this.extensions[name] !== null
  }

  getHook(extName, hookName) {
    return this.hooks[extName][hookName].bind(this.extensions[extName])
  }
  
}

module.exports = new ExtensionManager()
