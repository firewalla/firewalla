/*    Copyright 2016-2025 Firewalla Inc.
 *
 *    ;This program is free software: you can redistribute it and/or  modify
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

const { expect, assert } = require('chai');
const { CategoryEntry } = require("../control/CategoryEntry.js");

describe('Test category update sensor', function () {
    // this.timeout(10000);
    before(async () => {

    })

    it('should parse domain with port and return valid category entry list.', async () => {

        let entries = CategoryEntry.parse("dns.alidns.com:443");
        expect(entries.length).to.be.equal(3);
        expect(entries.filter(entry => entry.id === "dns.alidns.com" && entry.type === "domain" && entry.pcount === 1).length).to.be.equal(3);
        expect(entries.filter(entry => entry.domainOnly && entry.port.start === 443 && entry.port.end === 443 && entry.port.proto === "tcp").length).to.be.equal(1);
        expect(entries.filter(entry => entry.domainOnly && entry.port.start === 443 && entry.port.end === 443 && entry.port.proto === "udp").length).to.be.equal(1);
        expect(entries.filter(entry => !entry.domainOnly && entry.port.start === 443 && entry.port.end === 443 && entry.port.proto === "udp").length).to.be.equal(1);

    });

    it('should parse domain with protocol+port and return valid category entry list.', async () => {

        let entries = CategoryEntry.parse("doh.pub,tcp:443");
        expect(entries.length).to.be.equal(1);
        expect(entries.filter(entry => entry.id === "doh.pub"
            && entry.type === "domain" && entry.pcount === 1 && entry.domainOnly
            && entry.port.start === 443 && entry.port.end === 443 && entry.port.proto === "tcp").length).to.be.equal(1);
    });

    it('should parse domain with protocol and port range and return valid category entry list.', async () => {

        let entries = CategoryEntry.parse("doh.testmock.com,tcp:441-445");
        expect(entries.length).to.be.equal(3);
        expect(entries.filter(entry => entry.id === "doh.testmock.com" && entry.type === "domain" && entry.pcount === 2
            && !entry.domainOnly
            && entry.port.start === 441 && entry.port.end === 442 && entry.port.proto === "tcp").length).to.be.equal(1);
        expect(entries.filter(entry => entry.id === "doh.testmock.com" && entry.type === "domain" && entry.pcount === 1
            && entry.domainOnly
            && entry.port.start === 443 && entry.port.end === 443 && entry.port.proto === "tcp").length).to.be.equal(1);
        expect(entries.filter(entry => entry.id === "doh.testmock.com" && entry.type === "domain" && entry.pcount === 2
            && !entry.domainOnly
            && entry.port.start === 444 && entry.port.end === 445 && entry.port.proto === "tcp").length).to.be.equal(1);
    });

    it('should parse ipv4 with port and return valid category entry list.', async () => {

        let entries = CategoryEntry.parse("120.53.53.53:443");
        expect(entries.length).to.be.equal(3);
        expect(entries.filter(entry => entry.id === "120.53.53.53" && entry.type === "ipv4" && entry.pcount === 1
            && entry.domainOnly
            && entry.port.start === 443 && entry.port.end === 443 && entry.port.proto === "tcp").length).to.be.equal(1);
        expect(entries.filter(entry => entry.id === "120.53.53.53" && entry.type === "ipv4" && entry.pcount === 1
            && entry.domainOnly
            && entry.port.start === 443 && entry.port.end === 443 && entry.port.proto === "udp").length).to.be.equal(1);
        expect(entries.filter(entry => entry.id === "120.53.53.53" && entry.type === "ipv4" && entry.pcount === 1
            && !entry.domainOnly
            && entry.port.start === 443 && entry.port.end === 443 && entry.port.proto === "udp").length).to.be.equal(1);
    });

    it('should parse ipv4 with port range and return valid category entry list.', async () => {

        let entries = CategoryEntry.parse("12.8.8.8:441-445");
        expect(entries.length).to.be.equal(5);
        expect(entries.filter(entry => entry.id === "12.8.8.8" && entry.type === "ipv4").length).to.be.equal(5);
        expect(entries.filter(entry => entry.id === "12.8.8.8" && entry.type === "ipv4" && entry.pcount === 2
            && ! entry.domainOnly
            && entry.port.start === 441 && entry.port.end === 442 && entry.port.proto === "tcp").length).to.be.equal(1);
        expect(entries.filter(entry => entry.id === "12.8.8.8" && entry.type === "ipv4" && entry.pcount === 1
            && entry.domainOnly
            && entry.port.start === 443 && entry.port.end === 443 && entry.port.proto === "tcp").length).to.be.equal(1);
        expect(entries.filter(entry => entry.id === "12.8.8.8" && entry.type === "ipv4" && entry.pcount === 1
            && entry.domainOnly
            && entry.port.start === 443 && entry.port.end === 443 && entry.port.proto === "udp").length).to.be.equal(1);
        expect(entries.filter(entry => entry.id === "12.8.8.8" && entry.type === "ipv4" && entry.pcount === 5
            && !entry.domainOnly
            && entry.port.start === 441 && entry.port.end === 445 && entry.port.proto === "udp").length).to.be.equal(1);
    });


    it('should parse ipv6 with protocol+port and return valid category entry list.', async () => {

        let entries = CategoryEntry.parse("[2400:3200:baba::1],tcp:443");
        expect(entries.length).to.be.equal(1);
        expect(entries.filter(entry => entry.id === "2400:3200:baba::1"
            && entry.type === "ipv6" && entry.pcount === 1 && entry.domainOnly
            && entry.port.start === 443 && entry.port.end === 443 && entry.port.proto === "tcp").length).to.be.equal(1);
    });

    it('should parse ipv6 with port range and return valid category entry list.', async () => {

        let entries = CategoryEntry.parse("[2400:1234:5678::2]:443-445");
        expect(entries.length).to.be.equal(4);
        expect(entries.filter(entry => entry.id === "2400:1234:5678::2" && entry.type === "ipv6").length).to.be.equal(4);
        expect(entries.filter(entry => entry.pcount === 1 && entry.domainOnly
            && entry.port.start === 443 && entry.port.end === 443 && entry.port.proto === "tcp").length).to.be.equal(1);
    });

    it('should parse ipv6 with port range and return valid category entry list.', async () => {

        let entries = CategoryEntry.parse("[2400:1234:5678::2]:443-445");
        expect(entries.length).to.be.equal(4);
        expect(entries.filter(entry => entry.id === "2400:1234:5678::2" && entry.type === "ipv6").length).to.be.equal(4);
        expect(entries.filter(entry => entry.pcount === 1 && entry.domainOnly
            && entry.port.start === 443 && entry.port.end === 443 && entry.port.proto === "tcp").length).to.be.equal(1);
        expect(entries.filter(entry => entry.pcount === 1 && entry.domainOnly
            && entry.port.start === 443 && entry.port.end === 443 && entry.port.proto === "udp").length).to.be.equal(1);
        expect(entries.filter(entry => entry.pcount === 2 && !entry.domainOnly
            && entry.port.start === 444 && entry.port.end === 445 && entry.port.proto === "tcp").length).to.be.equal(1);
        expect(entries.filter(entry => entry.pcount === 3 && !entry.domainOnly
            && entry.port.start === 443 && entry.port.end === 445 && entry.port.proto === "udp").length).to.be.equal(1);
    });

});