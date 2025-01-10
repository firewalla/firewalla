const assert = require('chai').assert;



describe('WlanVendorInfo class', async () => {
  beforeEach(function() {
    // cleanup cache before each test
    delete require.cache[require.resolve('../util/WlanVendorInfo')];
  });

  it('should lookupWlanVendors successfully with small sample data example-oui.txt', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = "test_data/example-oui.txt";

    const fakeMac = "00:00:00:00:00:00";
    const fakeVendor = "0x0017F20A 0x00904C04 0x00101802 0x0050F202";
    const macVendorPairs = [{mac: fakeMac, vendor: fakeVendor}];
    const result = await WlanVendorInfo.lookupWlanVendors(macVendorPairs, testOuiFile);
    console.log("result:", result);

    assert.equal(result.size, 1);
    assert.equal(result.get(fakeMac).vendorName, "Apple, Inc.");
    assert.equal(result.get(fakeMac).maxMatchLen, 6);
  });

  it('should lookupWlanVendors successfully with nmap-mac-prefixes', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = "test_data/nmap-mac-prefixes";

    const fakeMac = "00:00:00:00:00:00";
    const fakeVendor = "0x0017F20A 0x00904C04 0x00101802 0x0050F202";
    const macVendorPairs = [{mac: fakeMac, vendor: fakeVendor}];
    const result = await WlanVendorInfo.lookupWlanVendors(macVendorPairs, testOuiFile);
    console.log("result:", result);

    assert.equal(result.size, 1);
    assert.equal(result.get(fakeMac).vendorName, "Apple, Inc.");
    assert.equal(result.get(fakeMac).maxMatchLen, 6);
  });


  it('should do best match with nmap-mac-prefixes', async() => {
    const WlanVendorInfo = require('../util/WlanVendorInfo');
    const testOuiFile = "test_data/nmap-mac-prefixes";

    const fakeMac = "00:00:00:00:00:00";
    const fakeVendor = "FCA47AA";
    const macVendorPairs = [{mac: fakeMac, vendor: fakeVendor}];
    const result = await WlanVendorInfo.lookupWlanVendors(macVendorPairs, testOuiFile);
    console.log("result:", result);

    assert.equal(result.size, 1);
    assert.equal(result.get(fakeMac).vendorName, "Shenzhen Elebao Technology Co., Ltd");
    assert.equal(result.get(fakeMac).maxMatchLen, 7);
  });


});