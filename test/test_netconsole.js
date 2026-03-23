/*    Copyright 2016-2025 Firewalla Inc.
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

const netconsole = require("../extension/netconsole/netconsole.js");
const NetconsolePlugin = require("../sensor/NetconsolePlugin.js")
const netconsolePlugin = new NetconsolePlugin({});

const config1 = {
    src_intf: "eth0",
    dst_port: 8866,
    dst_ip: "192.168.62.1",
    dst_mac: "20:6d:31:df:18:ed",
}

const config2 = {
    src_intf: "eth1",
    dst_port: 8866,
    dst_ip: "192.168.62.1",
    dst_mac: "20:6d:31:df:18:ed",
}

describe('Test netconsole extension', function () {
    this.timeout(30000);

    before(async () => {
        await netconsole.uninstallNetconsole();
    });

    after(async () => {
        await netconsole.uninstallNetconsole();
    });

    it.skip('should test netconsole installation', async () => {
        if (!await netconsole.isAvailable()) {
            expect(await netconsole.isInstalled()).to.be.false;
            return;
        }

        expect(await netconsole.isAvailable()).to.be.true;
        expect(await netconsole.isInstalled()).to.be.false;

        expect(await netconsole.installNetconsole(config1)).to.be.undefined;
        expect(await netconsole.isInstalled()).to.be.true;

        expect(await netconsole.uninstallNetconsole()).to.be.undefined;
        expect(await netconsole.isInstalled()).to.be.false;
    });


});

describe('Test netconsole sensor', function () {
    this.timeout(30000);

    before(async () => {
        netconsolePlugin.run();
        await netconsolePlugin.globalOn();
    });

    after(async () => {
        await netconsolePlugin.globalOff();
    });

    it.skip('should test netconsole policy', async () => {
        await netconsolePlugin.applyPolicy({}, "0.0.0.0", config1);
        expect(await netconsole.isInstalled()).to.be.true;

        await netconsolePlugin.applyPolicy({}, "0.0.0.0", config2);
        expect(await netconsole.isInstalled()).to.be.false;

        await netconsolePlugin.applyPolicy({}, "0.0.0.0", config1);
        expect(await netconsole.isInstalled()).to.be.true;

        await netconsolePlugin.applyPolicy({}, "0.0.0.0", {});
        expect(await netconsole.isInstalled()).to.be.false;
    });

    it('should test netconsole policy with invalid config', async () => {
        expect(netconsolePlugin.isValidPolicy(null)).to.be.false;
        expect(netconsolePlugin.isValidPolicy({})).to.be.false;
        expect(netconsolePlugin.isValidPolicy({ src_intf: "eth0", dst_port: 8866, dst_ip: "192.168.62.1", dst_mac: "20:6d:31:df:18:ed" })).to.be.true;
        expect(netconsolePlugin.isValidPolicy({ src_intf: "eth0", dst_port: "123", dst_ip: "192.168.62.1", dst_mac: "20:6d:31:df:18:ed" })).to.be.false;
        expect(netconsolePlugin.isValidPolicy({ src_intf: true, dst_port: 8866, dst_ip: "192.168.62.1", dst_mac: "20:6d:31:df:18:ed" })).to.be.false;
        expect(netconsolePlugin.isValidPolicy({ src_intf: "eth0", dst_port: 8866, dst_ip: "123", dst_mac: "20:6d:31:df:18:ed" })).to.be.false;
        expect(netconsolePlugin.isValidPolicy({ src_intf: "eth0", dst_port: 8866, dst_ip: "192.168.62.1", dst_mac: "123" })).to.be.false;
    });
});
