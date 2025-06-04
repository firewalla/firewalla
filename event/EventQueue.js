/*    Copyright 2016-2025 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
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

const log = require('../net2/logger.js')(__filename, 'info');
const Queue = require('bee-queue');

class EventQueue {
    constructor(name, idleTimeout=3600) {
        this.name = `${name}`;
        this.state = "not-created"; // state of the queue
        this.queue = null;   // Bee-Queue instance
        this.lastJobTs = 0;
        this.processHandler = null;

        this.checkTimer = setInterval(() => {
            this.checkIdle(idleTimeout);
        }, 3600000) // check recycle every 60m
    }

    getState() {
        if (this.state == "ready" && this.queue.client) return "ready";
        return this.state || "not-ready";
    }

    async setupEventQueue(concurrency=1, func=null) {
        this.queue = new Queue(this.name, {
            removeOnFailure: true,
            removeOnSuccess: true,
        });

        if (func !== null && typeof func === 'function') {
            this.processHandler = func;
        }

        this.queue.destroy(() => {
            log.info(`event queue ${this.name} is cleaned up`)
        });

        this.queue.on('failed', (job, err) => {
            log.info(`event queue ${this.name} process job failed, ${JSON.stringify(job.data)}, ${err.message}`);
        });

        this.queue.on('succeeded', (job) => {
            log.debug(`event queue ${this.name} process succeeded, ${JSON.stringify(job.data)}`);
        });

        // Process the queue with concurrency of 1
        this.queue.process(concurrency, async (job, done) => {
            log.debug(`event queue ${this.name} processing job: ${JSON.stringify(job.data)}`);
            const event = job.data;
            if (this.processHandler != null && typeof this.processHandler === 'function') {
                try {
                    await this.processHandler(event.event);
                    done();
                } catch (error) {
                    done(new Error(`event queue ${this.name} fail to process event: ${error.message}`));
                }
            } else {
                done(new Error(`event queue ${this.name} handler not executable, type ${typeof this.processHandler}`));
            }
        });

        return new Promise((resolve, reject) => {
            // wait for queue ready
            this.queue.on('ready', () => {
                this.state = "ready";
                log.info(`event queue ${this.name} is ready`);
                resolve();
            });

            // listen connection error
            this.queue.on('error', (err) => {
                this.state = "error";
                log.error(`event queue ${this.name} error, ${err.message}`);
                reject(err);
            });
        });
    }

    addEvent(event, timeout=3000, retry = true) {
        this.lastJobTs = Date.now();
        // set job process timeout to 5s
        return this.queue.createJob({event: event}).timeout(timeout).save((err) => {
            if (err) {
                log.warn(`event queue ${this.name} failed to create job, ${JSON.stringify(event)}, ${err.message}`);
                if (err.message && err.message.includes("NOSCRIPT")) {
                    // this is usually caused by unexpected redis restart and previously loaded scripts are flushed
                    log.info(`recreating event queue ${this.name} due to connection error, ${err.message}`);
                    this.queue.close(3000, () => {
                        this.setupEventQueue().then(() => {
                            log.info(`event queue ${this.name}  re-created successfully`);
                            if (retry) this.addEvent(event, timeout, false);
                        }).catch((rerr) => {
                            log.error(`event queue ${this.name} failed to recreate, ${rerr.message}`);
                        });
                    });
                }
            } else {
                log.debug(`event queue ${this.name} received job: ${JSON.stringify(event)}`);
            }
        });
    }

    // check if the queue is idle for more than idleThres seconds
   async checkIdle(idleTimeout=3600) {
        if (!this.queue || this.state == "closing") return;

        const now = Date.now();
        if (this.lastJobTs < now - idleTimeout * 1000) {
            log.info(`event queue ${this.name} is idle for more than ${idleTimeout} seconds, recycling...`);
            await this.recycle();
        }
    }

    // close the queue connection.
    async recycle() {
        log.debug(`event queue ${this.name} start recycle, state: ${this.state}`);
        if (!this.queue || this.state == "closing") return;
        this.state = "closing";
        try {
            // graceful close in 3000ms
            await this.queue.close(3000, () => {
                log.info(`event queue ${this.name} closed successfully`);
                if (this.queue) this.queue.destroy(); // cleanup queue data
            });
        } catch (err) {
            log.error(`event queue ${this.name} failed to close, ${err.message}`);
        } finally {
            this.state = "closed";
            this.queue = null;
            clearInterval(this.checkTimer);
            this.checkTimer = null;
        }
    }
}

module.exports = EventQueue;