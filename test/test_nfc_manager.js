/*    Copyright 2016-2026 Firewalla Inc.
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

const nfcManager = require("../net2/NFCManager.js")
const log = require("../net2/logger.js")(__filename);

let pid = 140;

describe('Test nfc manager', function () {
    this.timeout(30000);


    before(async () => {
    });

    after(async () => {
    });

    it.skip('should create nfc request', async () => {
        const req = await nfcManager.newRequest({ pid: pid, action: "pause", duration: 60000 });
        expect(req).to.be.an('object');
        expect(req.pid).to.be.equal(pid);
        expect(req.action).to.be.equal("pause");
        expect(req.duration).to.be.equal(60000);
        expect(req.ts).to.be.a('number');
        expect(req.policy).to.be.an('object');
        global.ts = req.ts;
    });

    it.skip('should list nfc requests', async () => {
        const reqs = await nfcManager.listRequests();
        expect(reqs).to.be.an('array');
        expect(reqs.length).to.be.equal(1);
        expect(reqs[0].pid).to.be.equal(140);
        expect(reqs[0].action).to.be.equal("pause");
        expect(reqs[0].duration).to.be.equal(60000);
        expect(reqs[0].ts).to.be.a('number');
    });

    it.skip('should get nfc request', async () => {
        const req = await nfcManager.getRequest(global.ts);
        expect(req).to.be.an('object');
        expect(req.action).to.be.equal("pause");
        expect(req.duration).to.be.equal(60000);
        expect(req.ts).to.be.a('number');
        expect(req.policy).to.be.an('object');
    });


    it.skip('should activate nfc request', async () => {

        global.ts = 1768208059586;
        const req = await nfcManager.activateRequest({ ts: global.ts });
        log.info(`req:`, req);
        expect(req).to.be.an('object');
        expect(req.pid).to.be.equal(pid);
        expect(req.action).to.be.equal("pause");
        expect(req.activatedAt).to.be.a('number');
        expect(req.policy.disabled).to.be.equal(1);
    });

});
