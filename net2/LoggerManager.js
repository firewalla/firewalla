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

let instance = null;

class LoggerManager {
  constructor() {
    if(instance === null) {
      instance = this;
      this.loggers = {}
    }
  }

  registerLogger(name, logger) {
    this.loggers[name] = logger;
  }

  setLogLevel(name, level) {
    const logger = this.loggers[name];

    if(logger) {
      logger.effectiveLogLevel = level;
    }
  }

  setGlobalLogLevel(level) {
    if(!level) {
      return;
    }
    
    const loggers = Object.values(this.loggers);
    if(loggers.length > 0) {
      const logger = loggers[0];
      logger.setGlobalLogLevel(level);
    }
  }
}

module.exports = new LoggerManager();