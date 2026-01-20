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
const CronJob = require('cron').CronJob;
const HostManager = require('../net2/HostManager.js');
const sysManager = require('../net2/SysManager.js');
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('../net2/Message.js');

const RESOURCES_DIR = '/data/fw_resources';
const CONTENT_SIZE_LIMIT = 1024 * 1024 * 2;

class ResourcePlugin extends Sensor {
  constructor(config) {
    super(config);
    this.initialized = false;
    this.cleanupJob = null;
    this.hostManager = new HostManager();
  }

  async run() {
    // Schedule initial cleanup job
    await this.scheduleCleanupJob();

    // Subscribe to timezone reload events to reschedule the job
    sclient.on("message", async (channel, message) => {
      if (channel === Message.MSG_SYS_TIMEZONE_RELOADED) {
        log.info("System timezone is reloaded, will reschedule resource cleanup cron job ...");
        await this.scheduleCleanupJob();
      }
    });
    sclient.subscribe(Message.MSG_SYS_TIMEZONE_RELOADED);
  }

  async scheduleCleanupJob() {
    // Schedule resource cleanup to run daily at midnight
    const tz = sysManager.getTimezone();
    const cron = '0 1 * * *'; // Daily at midnight
    
    if (this.cleanupJob) {
      this.cleanupJob.stop();
    }

    this.cleanupJob = new CronJob(cron, async () => {
      try {
        await this.cleanupUnusedResources();
      } catch (err) {
        log.error(`Failed to cleanup unused resources: ${err.message}`, err);
      }
    }, () => {}, true, tz);

    log.info('Resource cleanup cronjob scheduled');
  }

  async cleanupUnusedResources() {
    try {
      log.info('Starting resource cleanup...');
      
      // Load policy from HostManager to get resIdsInUse
      const policy = await this.hostManager.loadPolicyAsync();
      
      // Extract resIdsInUse from policy
      // Structure: { "resIdsInUse": ["123123", "456456"] }
      let resIdsInUse = [];
      if (policy && policy.resIdsInUse && Array.isArray(policy.resIdsInUse)) {
        resIdsInUse = policy.resIdsInUse;
      }

      // Convert to Set for efficient lookup
      const resIdsInUseSet = new Set(resIdsInUse.map(id => String(id)));
      
      log.info(`Found ${resIdsInUse.length} resources in use`);

      // Get all resources from filesystem
      const allResources = await this.getAllResources();
      log.info(`Found ${allResources.length} total resources on filesystem`);

      // Find unused resources
      const unusedResources = allResources.filter(resource => {
        if (!resource || !resource.resId) {
          return false;
        }
        return !resIdsInUseSet.has(String(resource.resId));
      });

      if (unusedResources.length === 0) {
        log.info('No unused resources to cleanup');
        return;
      }

      log.info(`Found ${unusedResources.length} unused resources to cleanup`);

      // Delete unused resources
      let deletedCount = 0;
      let errorCount = 0;
      
      for (const resource of unusedResources) {
        try {
          const resourcePath = this.getResourcePath(resource.resId);
          await fs.unlinkAsync(resourcePath);
          deletedCount++;
          log.info(`Deleted unused resource: ${resource.resId}`);
        } catch (err) {
          errorCount++;
          if (err.code === 'ENOENT') {
            // File already deleted, not an error
            deletedCount++;
            log.debug(`Resource already deleted: ${resource.resId}`);
          } else {
            log.error(`Failed to delete resource ${resource.resId}: ${err.message}`);
          }
        }
      }

      log.info(`Resource cleanup completed: ${deletedCount} deleted, ${errorCount} errors`);
    } catch (err) {
      log.error(`Error during resource cleanup: ${err.message}`, err);
      throw err;
    }
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

