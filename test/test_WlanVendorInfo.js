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

const assert = require('chai').assert;
const path = require('path');


describe('WlanVendorInfo class', async () => {
  const currentDir = __dirname;


  beforeEach(function() {
    // cleanup cache before each test
    delete require.cache[require.resolve('../util/WlanVendorInfo')];
  });

  it('should lookupWlanVendors successfully with small sample data example-oui.txt', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = path.join(currentDir, "test_data/example-oui.txt");

    const fakeMac = "00:00:00:00:00:00";
    const fakeVendor = "0x0017F20A";
    const macVendorPairs = [{mac: fakeMac, vendor: fakeVendor}];
    const result = await WlanVendorInfo.lookupWlanVendors(macVendorPairs, testOuiFile);
    console.log("result:", result);

    assert.equal(result.size, 1);
    assert.equal(result.get(fakeMac).length, 1);
    assert.equal(result.get(fakeMac)[0].vendorName, "Apple, Inc.");
    assert.equal(result.get(fakeMac)[0].maxMatchLen, 6);
  });


  it('should do best match with nmap-mac-prefixes, given FCA47AA match all 7 bytes', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = path.join(currentDir, "test_data/example-oui.txt");

    const fakeMac = "00:00:00:00:00:00";
    const fakeVendor = "FCA47AA";
    const macVendorPairs = [{mac: fakeMac, vendor: fakeVendor}];
    const result = await WlanVendorInfo.lookupWlanVendors(macVendorPairs, testOuiFile);
    console.log("result:", result);

    assert.equal(result.size, 1);
    assert.equal(result.get(fakeMac).length, 1);
    assert.equal(result.get(fakeMac)[0].vendorName, "Shenzhen Elebao Technology Co., Ltd");
    assert.equal(result.get(fakeMac)[0].maxMatchLen, 7);

  });

  it('should do best match with nmap-mac-prefixes, given FCA47AA0 match fisrt 7 bytes', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = path.join(currentDir, "test_data/example-oui.txt");

    const fakeMac = "00:00:00:00:00:00";
    const fakeVendor = "FCA47AA0";
    const macVendorPairs = [{mac: fakeMac, vendor: fakeVendor}];
    const result = await WlanVendorInfo.lookupWlanVendors(macVendorPairs, testOuiFile);
    console.log("result:", result);

    assert.equal(result.size, 1);
    assert.equal(result.get(fakeMac).length, 1);
    assert.equal(result.get(fakeMac)[0].vendorName, "Shenzhen Elebao Technology Co., Ltd");
    assert.equal(result.get(fakeMac)[0].maxMatchLen, 7);
  });

  it('should return all vendor info when there are multiple vendor IDs in the vendor Info', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = path.join(currentDir, "test_data/example-oui.txt");

    const fakeMac = "00:00:00:00:00:00";
    const fakeVendor = "0x0017F20A 0x00904C04 0x00101802 0x0050F202";
    const macVendorPairs = [{mac: fakeMac, vendor: fakeVendor}];
    const result = await WlanVendorInfo.lookupWlanVendors(macVendorPairs, testOuiFile);
    console.log("result:", result);

    assert.equal(result.size, 1);
    assert.equal(result.get(fakeMac).length, 4);
    assert.equal(result.get(fakeMac)[0].vendorName, "Apple, Inc.");
    assert.equal(result.get(fakeMac)[0].maxMatchLen, 6);
    assert.equal(result.get(fakeMac)[1].vendorName, "Epigram, Inc.");
    assert.equal(result.get(fakeMac)[1].maxMatchLen, 6);
    assert.equal(result.get(fakeMac)[2].vendorName, "Broadcom");
    assert.equal(result.get(fakeMac)[2].maxMatchLen, 6);
    assert.equal(result.get(fakeMac)[3].vendorName, "MICROSOFT CORP.");
    assert.equal(result.get(fakeMac)[3].maxMatchLen, 6);

  });

  it('should lookupWlanVendors successfully with two mac-vendor pairs', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = path.join(currentDir, "test_data/example-oui.txt");

    const fakeMac1 = "00:00:00:00:00:00";
    const fakeVendor1 = "0x0017F20A";
    const fakeMac2 = "00:00:00:00:00:01";
    const fakeVendor2 = "0x00904C04";

    const macVendorPairs = [{mac: fakeMac1, vendor: fakeVendor1}, {mac: fakeMac2, vendor: fakeVendor2}];
    const result = await WlanVendorInfo.lookupWlanVendors(macVendorPairs, testOuiFile);
    console.log("result:", result);

    assert.equal(result.size, 2);
    assert.equal(result.get(fakeMac1).length, 1);
    assert.equal(result.get(fakeMac1)[0].vendorName, "Apple, Inc.");
    assert.equal(result.get(fakeMac1)[0].maxMatchLen, 6);
    assert.equal(result.get(fakeMac2).length, 1);
    assert.equal(result.get(fakeMac2)[0].vendorName, "Epigram, Inc.");
    assert.equal(result.get(fakeMac2)[0].maxMatchLen, 6);
  });

  it('should lookupMacVendor successfully with a valid mac, best match 6 bytes', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = path.join(currentDir, "test_data/example-oui.txt");

    const mac1 = "20:6d:31:41:3e:03";

    const result = await WlanVendorInfo.lookupMacVendor(mac1, 6, testOuiFile);
    console.log("result:", result);

    assert.equal(result, "FIREWALLA INC");

  });

  it('should lookupMacVendor successfully with a valid mac, best match 7 bytes', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = path.join(currentDir, "test_data/example-oui.txt");
    //FCA47A0 Broadcom Inc.
    const mac1 = "FC:A4:7A:01:3e:03";

    const result = await WlanVendorInfo.lookupMacVendor(mac1, 6, testOuiFile);
    console.log("result:", result);

    assert.equal(result, "Broadcom Inc.");

  });


  it('should lookupMacVendor successfully with a valid mac, best match 9 bytes', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = path.join(currentDir, "test_data/example-oui.txt");
    //70B3D593F Vision Sensing Co., Ltd.
    const mac1 = "70:B3:D5:93:F1:3E";

    const result = await WlanVendorInfo.lookupMacVendor(mac1, 6, testOuiFile);
    console.log("result:", result);

    assert.equal(result, "Vision Sensing Co., Ltd.");

  });

  it('should lookupMacVendor return null when mac is a private address', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = path.join(currentDir, "test_data/example-oui.txt");

    const mac1 = "C2:D2:25:E0:16:7F";

    const result = await WlanVendorInfo.lookupMacVendor(mac1, 6, testOuiFile);
    console.log("result:", result);

    assert.equal(result, null);

  });




});