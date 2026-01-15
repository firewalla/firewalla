/*    Copyright 2024 Firewalla Inc.
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

const Sensor = require('./Sensor.js').Sensor;
const extensionManager = require('./ExtensionManager.js');
const log = require('../net2/logger.js')(__filename);

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const crypto = require('crypto');
const path = require('path');
const execAsync = require('child-process-promise').exec;

const RESOURCES_DIR = '/data/fw_resources';
const CONTENT_SIZE_LIMIT = 1024 * 1024 * 2;

class ResourcePlugin extends Sensor {
  constructor(config) {
    super(config);
    this.initialized = false;
  }

  async apiRun() {
    // Register update_resources command handler
    extensionManager.onCmd("update_resources", async (msg, data) => {
      if (!data || !data.resources) {
        throw { code: 400, msg: "'resources' is required" };
      }
      return await this.updateResources(data.resources);
    });

    // Register resources get handler
    extensionManager.onGet("resources", async (msg, data) => {
      if (!data || !data.resIds) {
        throw { code: 400, msg: "'resIds' is required" };
      }
      return await this.getResources(data.resIds);
    });
  }

  async ensureDirectory() {
    if (this.initialized) {
      return;
    }

    try {
      // Check if directory exists
      try {
        await fs.accessAsync(RESOURCES_DIR, fs.constants.F_OK);
        this.initialized = true;
        return;
      } catch (err) {
        // Directory doesn't exist, create it
      }

      // Create directory with root permissions
      await execAsync(`sudo mkdir -p ${RESOURCES_DIR}`);
      
      // Change ownership to pi user
      await execAsync(`sudo chown pi:pi ${RESOURCES_DIR}`);
      
      // Set permissions
      await execAsync(`sudo chmod 755 ${RESOURCES_DIR}`);
      
      this.initialized = true;
      log.info(`Resources directory created: ${RESOURCES_DIR}`);
    } catch (err) {
      log.error(`Failed to create resources directory: ${err.message}`);
      throw err;
    }
  }

  getResourcePath(resId) {
    return path.join(RESOURCES_DIR, resId);
  }

  calculateSha256(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  async updateResource(resId, base64) {
    await this.ensureDirectory();
    
    if (!resId) {
      throw new Error('resId is required');
    }

    const resourcePath = this.getResourcePath(resId);

    if (base64 === null || base64 === undefined) {
      // Delete resource
      try {
        await fs.unlinkAsync(resourcePath);
        log.info(`Resource deleted: ${resId}`);
        return null; // Return null to indicate deletion
      } catch (err) {
        if (err.code === 'ENOENT') {
          // File doesn't exist, already deleted
          log.info(`Resource already deleted: ${resId}`);
          return null;
        }
        throw err;
      }
    } else {
      // Update resource
      let content;
      try {
        content = Buffer.from(base64, 'base64');
      } catch (err) {
        throw new Error(`ERR_INVALID_BASE64`);
      }

      if (content.length > CONTENT_SIZE_LIMIT) {
        throw new Error(`ERR_CONTENT_TOO_LARGE`);
      }

      const sha256 = this.calculateSha256(content);
      
      try {
        await fs.writeFileAsync(resourcePath, content);
        log.info(`Resource updated: ${resId}, sha256: ${sha256}`);
        return {
          resId: resId,
          sha256: sha256
        };
      } catch (err) {
        log.error(`Failed to write resource ${resId}: ${err.message}`);
        throw err;
      }
    }
  }

  async getResource(resId, withContent = true) {
    await this.ensureDirectory();
    
    if (!resId) {
      throw new Error('resId is required');
    }

    try {
      const resourcePath = this.getResourcePath(resId);
      const content = await fs.readFileAsync(resourcePath);
      const sha256 = this.calculateSha256(content);
      
      const result = {
        resId: resId,
        sha256: sha256
      };

      if (withContent) {
        result.base64 = content.toString('base64');
      }
      
      return result;
    } catch (err) {
      if (err.code === 'ENOENT') {
        log.warn(`Resource not found: ${resId}`);
        return {
            resId: resId,
            err: "ERR_NOT_FOUND"
        };
      }
      log.error(`Failed to read resource ${resId}: ${err.message}`);
      throw err;
    }
  }

  async updateResources(resources) {
    if (!Array.isArray(resources)) {
      throw new Error('resources must be an array');
    }

    // Filter out resources without resId and process them in parallel
    const updatePromises = resources
      .filter(resource => {
        if (!resource.resId) {
          log.warn('Skipping resource without resId');
          return false;
        }
        return true;
      })
      .map(async (resource) => {
        try {
          const result = await this.updateResource(resource.resId, resource.base64);
          // Only include in results if it was updated (not deleted)
          return result !== null ? result : null;
        } catch (err) {
          log.error(`Failed to update resource ${resource.resId}: ${err.message}`);
          return {
            resId: resource.resId,
            err: err.message.startsWith("ERR_") ? err.message : "ERR_UPDATE_FAILED"
          };
        }
      });

    const results = await Promise.all(updatePromises);
    
    // Filter out null values (deleted resources)
    return {
      resources: results.filter(r => r !== null)
    };
  }

  async getResources(resIds) {
    if (!Array.isArray(resIds)) {
      throw new Error('resIds must be an array');
    }

    // Process all resources in parallel
    const getPromises = resIds.map(async (resId) => {
      try {
        const resource = await this.getResource(resId);
        return resource;
      } catch (err) {
        log.error(`Failed to get resource ${resId}: ${err.message}`);
        return {
            resId: resId,
            err: "ERR_GET_FAILED"
        }
      }
    });

    const results = await Promise.all(getPromises);
    
    // Filter out null values (resources not found)
    return {
      resources: results.filter(r => r !== null)
    };
  }

  async getAllResources() {
    await this.ensureDirectory();
    
    const results = [];

    try {
      // Check if directory exists
      try {
        await fs.accessAsync(RESOURCES_DIR, fs.constants.F_OK);
      } catch (err) {
        // Directory doesn't exist, return empty array
        return results;
      }

      // Read all files in the directory
      const files = await fs.readdirAsync(RESOURCES_DIR).catch((err) => {
        log.error(`Failed to read resources directory: ${err.message}`);
        return [];
      });

      // Process each file using getResource (without content for efficiency)
      const resources = await Promise.all(files.map(async (filename) => {
        const filePath = this.getResourcePath(filename);
        try {
          // Check if it's a file (not a directory)
          const stats = await fs.statAsync(filePath);
          if (!stats.isFile()) {
            return null;
          }

          // Use getResource to get resId and sha256 (without base64 content)
          return await this.getResource(filename, false);
        } catch (err) {
          log.error(`Failed to process resource file ${filename}: ${err.message}`);
          return null;
        }
      }));

      // Filter out null values
      return resources.filter(r => r !== null);
    } catch (err) {
      log.error(`Failed to get all resources: ${err.message}`);
      return results;
    }
  }
}

module.exports = ResourcePlugin;

