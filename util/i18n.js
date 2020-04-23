'use strict';

const log = require('../net2/logger.js')(__filename);
let flat = require('flat');
let util = require('util');

let f = require('../net2/Firewalla.js');
const Mustache = require('mustache');
const fs = require('fs');
const existsAsync = util.promisify(fs.exists);

let instance = null;
class i18n {
  constructor() {
    if (instance == null) {
      instance = this;
      this.setLocale("en");
    }
    return instance;
  }
  
  __(msgTemplate, info) {
    if (!(this.localeJson && this.localeJson.hasOwnProperty(msgTemplate))) {
      return msgTemplate;
    }
    
    return Mustache.render(this.localeJson[msgTemplate], flat.unflatten(info));
  }
  
  async setLocale(locale) {
    if (this.defaultLocale != locale) {
      this.defaultLocale = locale;
      const directory = f.getLocalesDirectory();
      this.localeJson = require(`${directory}/en.json`);
      if (this.defaultLocale != "en") {
        let filePath = `${directory}/${this.defaultLocale}.json`;
        const fileExists = await existsAsync(filePath);
        if (fileExists) {
          const newJson = require(filePath);
          Object.assign(this.localeJson, newJson);
        }
      }
    }

    return this.defaultLocale;
  }

  getLocale() {
    return this.defaultLocale;
  }
}

module.exports = new i18n();
