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
const fs = require('fs');
const os = require('os');

// RFC 7042 documentation MAC. Its prefixes are 00005E (6 digits), 00005E0 (7) and 00005E005 (9).
const DOC_MAC = '00:00:5E:00:53:01';
// Entries in nmap-mac-prefixes order; each group has the block covering DOC_MAC between two neighbors.
// IEEE carves MA-M and MA-S blocks only out of OUIs it keeps, so 00005E appears either as IEEE's
// (the parent of the MA-M and MA-S blocks below) or as a vendor's own OUI with nothing under it.
const IEEE_RA = 'IEEE Registration Authority';
const MA_L_IEEE = ['00005D Neighbor Large Before', `00005E ${IEEE_RA}`, '00005F Neighbor Large After'];
const MA_L_VENDOR = ['00005D Neighbor Large Before', '00005E Example Large Block', '00005F Neighbor Large After'];
const MA_M =['00005D0 Neighbor Medium Before', '00005E0 Example Medium Block', '00005E1 Neighbor Medium After'];
const MA_S = ['00005E004 Neighbor Small Before', '00005E005 Example Small Block', '00005E006 Neighbor Small After'];
const withoutExample = (lines) => lines.filter(l => !l.includes('Example'));


describe('WlanVendorInfo class', async () => {
  const currentDir = __dirname;
  let fixtureDir = null;
  let fixtureCount = 0;

  function writeOuiFixture(lines, trailingNewline = true) {
    const file = path.join(fixtureDir, `oui-${fixtureCount++}.txt`);
    fs.writeFileSync(file, lines.join('\n') + (trailingNewline ? '\n' : ''));
    return file;
  }

  before(function() {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oui-fixture-'));
  });

  after(function() {
    fs.rmdirSync(fixtureDir, { recursive: true });
  });


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

    const result = await WlanVendorInfo.lookupMacVendor(mac1, testOuiFile);
    console.log("result:", result);

    assert.equal(result, "FIREWALLA INC");

  });

  it('should lookupMacVendor successfully with a valid mac, best match 7 bytes', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = path.join(currentDir, "test_data/example-oui.txt");
    //FCA47A0 Broadcom Inc.
    const mac1 = "FC:A4:7A:01:3e:03";

    const result = await WlanVendorInfo.lookupMacVendor(mac1, testOuiFile);
    console.log("result:", result);

    assert.equal(result, "Broadcom Inc.");

  });


  it('should lookupMacVendor successfully with a valid mac, best match 9 bytes', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = path.join(currentDir, "test_data/example-oui.txt");
    //70B3D593F Vision Sensing Co., Ltd.
    const mac1 = "70:B3:D5:93:F1:3E";

    const result = await WlanVendorInfo.lookupMacVendor(mac1, testOuiFile);
    console.log("result:", result);

    assert.equal(result, "Vision Sensing Co., Ltd.");

  });

  it('should lookupMacVendor return null when mac is a private address', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = path.join(currentDir, "test_data/example-oui.txt");

    const mac1 = "C2:D2:25:E0:16:7F";

    const result = await WlanVendorInfo.lookupMacVendor(mac1, testOuiFile);
    console.log("result:", result);

    assert.equal(result, null);

  });

  it('should lookupMacVendor return null when only a longer entry partially matches', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    // DOC_MAC shares its first 6 digits with 00005E1 and its first 8 with 00005E004, but neither entry
    // is a prefix of it, and there is no MA-L entry
    const testOuiFile = writeOuiFixture(['00005E1 Neighbor Medium After', '00005E004 Neighbor Small Before']);

    const result = await WlanVendorInfo.lookupMacVendor(DOC_MAC, testOuiFile);

    assert.equal(result, null);
  });

  describe('lookupMacVendor', () => {
    it('returns the MA-S vendor when the MAC falls in an MA-S block', async() => {
      const WlanVendorInfo = require('../util/WlanVendorInfo');
      const testOuiFile = writeOuiFixture([...MA_L_IEEE, ...MA_M, ...MA_S]);

      assert.equal(await WlanVendorInfo.lookupMacVendor(DOC_MAC, testOuiFile), "Example Small Block");
    });

    it('returns the MA-M vendor when no MA-S entry covers the MAC', async() => {
      const WlanVendorInfo = require('../util/WlanVendorInfo');
      const testOuiFile = writeOuiFixture([...MA_L_IEEE, ...MA_M, ...withoutExample(MA_S)]);

      assert.equal(await WlanVendorInfo.lookupMacVendor(DOC_MAC, testOuiFile), "Example Medium Block");
    });

    it('returns the IEEE entry when no MA-M or MA-S block under it covers the MAC', async() => {
      const WlanVendorInfo = require('../util/WlanVendorInfo');
      const testOuiFile = writeOuiFixture([...MA_L_IEEE, ...withoutExample(MA_M), ...withoutExample(MA_S)]);

      assert.equal(await WlanVendorInfo.lookupMacVendor(DOC_MAC, testOuiFile), IEEE_RA);
    });

    it('returns the MA-L vendor when the OUI is held by a vendor', async() => {
      const WlanVendorInfo = require('../util/WlanVendorInfo');
      const testOuiFile = writeOuiFixture([...MA_L_VENDOR, ...withoutExample(MA_M), ...withoutExample(MA_S)]);

      assert.equal(await WlanVendorInfo.lookupMacVendor(DOC_MAC, testOuiFile), "Example Large Block");
    });

    it('does not look for smaller blocks under an OUI held by a vendor', async() => {
      const WlanVendorInfo = require('../util/WlanVendorInfo');
      // IEEE never places MA-M or MA-S blocks under a vendor's OUI, so these entries cannot occur in a
      // real file; the vendor's MA-L entry is the answer without searching them
      const testOuiFile = writeOuiFixture([...MA_L_VENDOR, ...MA_M, ...MA_S]);

      assert.equal(await WlanVendorInfo.lookupMacVendor(DOC_MAC, testOuiFile), "Example Large Block");
    });

    it('finds MA-M and MA-S blocks that have no MA-L line', async() => {
      const WlanVendorInfo = require('../util/WlanVendorInfo');
      const mediumOnly = writeOuiFixture([...withoutExample(MA_L_VENDOR), ...MA_M]);
      const smallOnly = writeOuiFixture([...withoutExample(MA_L_VENDOR), ...MA_S]);

      assert.equal(await WlanVendorInfo.lookupMacVendor(DOC_MAC, mediumOnly), "Example Medium Block");
      assert.equal(await WlanVendorInfo.lookupMacVendor(DOC_MAC, smallOnly), "Example Small Block");
    });

    it('returns null when no entry covers the MAC', async() => {
      const WlanVendorInfo = require('../util/WlanVendorInfo');
      const testOuiFile = writeOuiFixture([...withoutExample(MA_L_VENDOR), ...withoutExample(MA_M), ...withoutExample(MA_S)]);

      assert.equal(await WlanVendorInfo.lookupMacVendor(DOC_MAC, testOuiFile), null);
    });

    it('finds an entry on the first line and on a last line without a trailing newline', async() => {
      const WlanVendorInfo = require('../util/WlanVendorInfo');
      const firstLine = writeOuiFixture(['00005E Example Large Block', '00005F Neighbor Large After']);
      const lastLine = writeOuiFixture([...MA_L_IEEE, '00005E005 Example Small Block'], false);

      assert.equal(await WlanVendorInfo.lookupMacVendor(DOC_MAC, firstLine), "Example Large Block");
      assert.equal(await WlanVendorInfo.lookupMacVendor(DOC_MAC, lastLine), "Example Small Block");
    });

    it('skips blank and comment lines', async() => {
      const WlanVendorInfo = require('../util/WlanVendorInfo');
      const testOuiFile = writeOuiFixture(['# generated fixture', ...MA_L_IEEE, '', ...withoutExample(MA_M), '', '# small blocks', ...MA_S, '']);

      assert.equal(await WlanVendorInfo.lookupMacVendor(DOC_MAC, testOuiFile), "Example Small Block");
    });

    it('returns null for input that is not a whole MAC', async() => {
      const WlanVendorInfo = require('../util/WlanVendorInfo');
      const testOuiFile = writeOuiFixture([...MA_L_IEEE, ...MA_M, ...MA_S]);

      for (const mac of[undefined, null, '', '00:00:5E:00:53', '00:00:5E:00:53:0G', '00:00:5E:00:53:01:02', 'not a mac']) {
        assert.equal(await WlanVendorInfo.lookupMacVendor(mac, testOuiFile), null, String(mac));
      }
    });

    it('returns null when the OUI file does not exist', async() => {
      const WlanVendorInfo = require('../util/WlanVendorInfo');

      assert.equal(await WlanVendorInfo.lookupMacVendor(DOC_MAC, path.join(fixtureDir, 'missing.txt')), null);
    });
  });




});