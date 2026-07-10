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
'use strict'

let chai = require('chai');
let expect = chai.expect;
let log = require('../net2/logger')(__filename);
const EventQueue = require('../event/EventQueue.js');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const test_handler = async (event) => {
    log.debug(`process: ${JSON.stringify(event)}`);
    await sleep(event.delay || 500); // Simulate processing time
    log.debug(`finished: ${JSON.stringify(event)}`);
};

describe('Event queue', function() {
    this.timeout(10000);

    before(async() => {
        this.queue = new EventQueue('AB:CD:EF_eth0');
        expect(this.queue.getState()).to.equal('not-created');

        await this.queue.setupEventQueue(1, test_handler.bind(this.queue)); // Setup queue with concurrency of 1

        expect(this.queue.getState()).to.equal('ready');
        expect(this.queue).to.be.an.instanceof(EventQueue);
        expect(this.queue.name).to.equal('AB:CD:EF_eth0');
        expect(this.queue.queue).to.exist;
        expect(this.queue.queue.name).to.equal('AB:CD:EF_eth0');
    });

    after(async() => {
        expect(this.queue.getState()).to.equal('ready');
        await this.queue.recycle();
        expect(this.queue.getState()).to.equal('closed');
    });

    it('should add job to queue', async() =>{
        this.queue.addEvent({ id: 'test1', data: 'test data 1' });
        this.queue.addEvent({ id: 'test2', data: 'test data 2' });
        this.queue.addEvent({ id: 'test3', data: 'test data 3' });

        await sleep(2000);
    });

    it('should job timeout', async() =>{
        this.queue.addEvent({ id: 'test1', delay: 200 }, 100);
        await sleep(500);
    });

});
