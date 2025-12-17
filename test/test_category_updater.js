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

const { expect, assert } = require('chai');
const CategoryUpdater = require('../control/CategoryUpdater.js');
const Block = require('../control/Block.js');
const Constants = require('../net2/Constants.js');
const rclient = require('../util/redis_manager.js').getRedisClient();


describe('Test CategoryUpdater.processSignatureData', function() {
  this.timeout(10000);
  
  let categoryUpdater;
  let originalMethods = {};
  let callCounts = {};

  beforeEach(async () => {
    categoryUpdater = new CategoryUpdater();
    
    // Reset flowSignatureConfig
    categoryUpdater.flowSignatureConfig = {};
    
    // Reset activeCategories
    categoryUpdater.activeCategories = {};
    
    // Reset call counts
    callCounts = {
      getSignatureConfig: 0,
      batchBlockConnection: 0,
      addSigDetectedServer: 0,
      getConnectionIPSetName: 0,
      isActivated: 0
    };
  });

  afterEach(() => {
    // Restore original methods
    if (originalMethods.getSignatureConfig) {
      categoryUpdater.getSignatureConfig = originalMethods.getSignatureConfig;
    }
    if (originalMethods.addSigDetectedServer) {
      categoryUpdater.addSigDetectedServer = originalMethods.addSigDetectedServer;
    }
    if (originalMethods.getConnectionIPSetName) {
      categoryUpdater.getConnectionIPSetName = originalMethods.getConnectionIPSetName;
    }
    if (originalMethods.isActivated) {
      categoryUpdater.isActivated = originalMethods.isActivated;
    }
    if (originalMethods.batchBlockConnection) {
      Block.batchBlockConnection = originalMethods.batchBlockConnection;
    }
    originalMethods = {};
  });

  it('should return early when signature config is not found', async () => {
    const sigData = {
      sigId: 'non_existent_sig',
      remoteAddr: '1.2.3.4',
      remotePorts: [443]
    };

    // Save original method
    originalMethods.getSignatureConfig = categoryUpdater.getSignatureConfig;
    originalMethods.batchBlockConnection = Block.batchBlockConnection;
    originalMethods.addSigDetectedServer = categoryUpdater.addSigDetectedServer;

    // Stub methods
    categoryUpdater.getSignatureConfig = function(sigId) {
      callCounts.getSignatureConfig++;
      return null;
    };
    
    Block.batchBlockConnection = function() {
      callCounts.batchBlockConnection++;
      return Promise.resolve();
    };
    
    categoryUpdater.addSigDetectedServer = function() {
      callCounts.addSigDetectedServer++;
      return Promise.resolve();
    };

    await categoryUpdater.processSignatureData(sigData);

    expect(callCounts.getSignatureConfig).to.equal(1);
    expect(callCounts.batchBlockConnection).to.equal(0);
    expect(callCounts.addSigDetectedServer).to.equal(0);
  });

  it('should return early when signature config has no categories', async () => {
    const sigData = {
      sigId: 'sig_without_categories',
      remoteAddr: '1.2.3.4',
      remotePorts: [443]
    };

    categoryUpdater.flowSignatureConfig = {
      'sig_without_categories': {
        proto: 'tcp'
        // no categories
      }
    };

    originalMethods.batchBlockConnection = Block.batchBlockConnection;
    originalMethods.addSigDetectedServer = categoryUpdater.addSigDetectedServer;

    Block.batchBlockConnection = function() {
      callCounts.batchBlockConnection++;
      return Promise.resolve();
    };
    
    categoryUpdater.addSigDetectedServer = function() {
      callCounts.addSigDetectedServer++;
      return Promise.resolve();
    };

    await categoryUpdater.processSignatureData(sigData);

    expect(callCounts.batchBlockConnection).to.equal(0);
    expect(callCounts.addSigDetectedServer).to.equal(0);
  });

  it('should use default protocol "udp" when proto is not specified', async () => {
    const sigData = {
      sigId: 'test_sig',
      remoteAddr: '1.2.3.4',
      remotePorts: [443]
    };

    categoryUpdater.flowSignatureConfig = {
      'test_sig': {
        categories: ['test_category'],
        blockType: 'ipPort'
      }
    };

    let capturedProtocol = null;
    originalMethods.addSigDetectedServer = categoryUpdater.addSigDetectedServer;

    categoryUpdater.addSigDetectedServer = function(category, sigData) {
      callCounts.addSigDetectedServer++;
      capturedProtocol = sigData.protocol;
      return Promise.resolve();
    };

    await categoryUpdater.processSignatureData(sigData);

    expect(callCounts.addSigDetectedServer).to.equal(1);
    expect(capturedProtocol).to.equal('udp');
  });

  it('should use protocol from sigConfig when specified', async () => {
    const sigData = {
      sigId: 'test_sig',
      remoteAddr: '1.2.3.4',
      remotePorts: [443]
    };

    categoryUpdater.flowSignatureConfig = {
      'test_sig': {
        categories: ['porn'],
        blockType: 'ipPort',
        proto: 'tcp'
      }
    };

    let capturedProtocol = null;
    originalMethods.addSigDetectedServer = categoryUpdater.addSigDetectedServer;

    categoryUpdater.addSigDetectedServer = function(category, sigData) {
      callCounts.addSigDetectedServer++;
      capturedProtocol = sigData.protocol;
      return Promise.resolve();
    };

    await categoryUpdater.processSignatureData(sigData);

    expect(callCounts.addSigDetectedServer).to.equal(1);
    expect(capturedProtocol).to.equal('tcp');
  });

  it('should process connection block type when category is activated', async () => {
    const sigData = {
      sigId: 'test_sig',
      remoteAddr: '1.2.3.4',
      remotePorts: [443]
    };

    categoryUpdater.flowSignatureConfig = {
      'test_sig': {
        categories: ['test_category'],
        blockType: 'connection',
        proto: 'tcp'
      }
    };

    categoryUpdater.activeCategories = { 'test_category': 1 };
    
    let capturedConnSet = null;
    let capturedSigData = null;
    
    originalMethods.getConnectionIPSetName = categoryUpdater.getConnectionIPSetName;
    originalMethods.batchBlockConnection = Block.batchBlockConnection;
    originalMethods.isActivated = categoryUpdater.isActivated;

    categoryUpdater.getConnectionIPSetName = function(category) {
      callCounts.getConnectionIPSetName++;
      return 'test_conn_set';
    };
    
    Block.batchBlockConnection = function(sigDataArray, connSet, options) {
      callCounts.batchBlockConnection++;
      capturedSigData = sigDataArray;
      capturedConnSet = connSet;
      return Promise.resolve();
    };
    
    categoryUpdater.isActivated = function(category) {
      callCounts.isActivated++;
      return true;
    };

    await categoryUpdater.processSignatureData(sigData);

    expect(callCounts.isActivated).to.equal(1);
    expect(callCounts.getConnectionIPSetName).to.equal(1);
    expect(callCounts.batchBlockConnection).to.equal(1);
    expect(capturedConnSet).to.equal('test_conn_set');
    expect(capturedSigData).to.deep.equal([sigData]);
  });

  it('should skip connection block type when category is not activated', async () => {
    const sigData = {
      sigId: 'test_sig',
      remoteAddr: '1.2.3.4',
      remotePorts: [443]
    };

    categoryUpdater.flowSignatureConfig = {
      'test_sig': {
        categories: ['test_category'],
        blockType: 'connection',
        proto: 'tcp'
      }
    };

    categoryUpdater.activeCategories = {};
    
    originalMethods.batchBlockConnection = Block.batchBlockConnection;
    originalMethods.isActivated = categoryUpdater.isActivated;

    Block.batchBlockConnection = function() {
      callCounts.batchBlockConnection++;
      return Promise.resolve();
    };
    
    categoryUpdater.isActivated = function(category) {
      callCounts.isActivated++;
      return false;
    };

    await categoryUpdater.processSignatureData(sigData);

    expect(callCounts.isActivated).to.equal(1);
    expect(callCounts.batchBlockConnection).to.equal(0);
  });

  it('should process connection block type with timeout option', async () => {
    const sigData = {
      sigId: 'test_sig',
      remoteAddr: '1.2.3.4',
      remotePorts: [443]
    };

    categoryUpdater.flowSignatureConfig = {
      'test_sig': {
        categories: ['test_category'],
        blockType: 'connection',
        proto: 'tcp',
        timeout: 300
      }
    };

    categoryUpdater.activeCategories = { 'test_category': 1 };
    
    let capturedOptions = null;
    
    originalMethods.getConnectionIPSetName = categoryUpdater.getConnectionIPSetName;
    originalMethods.batchBlockConnection = Block.batchBlockConnection;
    originalMethods.isActivated = categoryUpdater.isActivated;

    categoryUpdater.getConnectionIPSetName = function(category) {
      return 'test_conn_set';
    };
    
    Block.batchBlockConnection = function(sigDataArray, connSet, options) {
      callCounts.batchBlockConnection++;
      capturedOptions = options;
      return Promise.resolve();
    };
    
    categoryUpdater.isActivated = function(category) {
      return true;
    };

    await categoryUpdater.processSignatureData(sigData);

    expect(callCounts.batchBlockConnection).to.equal(1);
    expect(capturedOptions).to.deep.equal({ timeout: 300 });
  });

  it('should process ipPort block type', async () => {
    const sigData = {
      sigId: 'test_sig',
      remoteAddr: '1.2.3.4',
      remotePorts: [443]
    };

    categoryUpdater.flowSignatureConfig = {
      'test_sig': {
        categories: ['test_category'],
        blockType: 'ipPort',
        proto: 'tcp'
      }
    };

    let capturedCategory = null;
    let capturedSigData = null;
    
    originalMethods.addSigDetectedServer = categoryUpdater.addSigDetectedServer;

    categoryUpdater.addSigDetectedServer = function(category, sigData) {
      callCounts.addSigDetectedServer++;
      capturedCategory = category;
      capturedSigData = sigData;
      return Promise.resolve();
    };

    await categoryUpdater.processSignatureData(sigData);

    expect(callCounts.addSigDetectedServer).to.equal(1);
    expect(capturedCategory).to.equal('test_category');
    expect(capturedSigData).to.deep.equal(sigData);
  });

  it('should process multiple categories', async () => {
    const sigData = {
      sigId: 'test_sig',
      remoteAddr: '1.2.3.4',
      remotePorts: [443]
    };

    categoryUpdater.flowSignatureConfig = {
      'test_sig': {
        categories: ['test_category1', 'test_category2'],
        blockType: 'ipPort',
        proto: 'tcp'
      }
    };

    const capturedCategories = [];
    
    originalMethods.addSigDetectedServer = categoryUpdater.addSigDetectedServer;

    categoryUpdater.addSigDetectedServer = function(category, sigData) {
      callCounts.addSigDetectedServer++;
      capturedCategories.push(category);
      return Promise.resolve();
    };

    await categoryUpdater.processSignatureData(sigData);

    expect(callCounts.addSigDetectedServer).to.equal(2);
    expect(capturedCategories).to.deep.equal(['test_category1', 'test_category2']);
  });

  it('should use default blockType "connection" when not specified', async () => {
    const sigData = {
      sigId: 'test_sig',
      remoteAddr: '1.2.3.4',
      remotePorts: [443]
    };

    categoryUpdater.flowSignatureConfig = {
      'test_sig': {
        categories: ['test_category']
        // no blockType specified
      }
    };

    categoryUpdater.activeCategories = { 'test_category': 1 };
    
    originalMethods.getConnectionIPSetName = categoryUpdater.getConnectionIPSetName;
    originalMethods.batchBlockConnection = Block.batchBlockConnection;
    originalMethods.isActivated = categoryUpdater.isActivated;

    categoryUpdater.getConnectionIPSetName = function(category) {
      return 'test_conn_set';
    };
    
    Block.batchBlockConnection = function() {
      callCounts.batchBlockConnection++;
      return Promise.resolve();
    };
    
    categoryUpdater.isActivated = function(category) {
      return true;
    };

    await categoryUpdater.processSignatureData(sigData);

    expect(callCounts.batchBlockConnection).to.equal(1);
  });

  it('should handle errors from batchBlockConnection gracefully', async () => {
    const sigData = {
      sigId: 'test_sig',
      remoteAddr: '1.2.3.4',
      remotePorts: [443]
    };

    categoryUpdater.flowSignatureConfig = {
      'test_sig': {
        categories: ['test_category'],
        blockType: 'connection',
        proto: 'tcp'
      }
    };

    categoryUpdater.activeCategories = { 'test_category': 1 };
    
    originalMethods.getConnectionIPSetName = categoryUpdater.getConnectionIPSetName;
    originalMethods.batchBlockConnection = Block.batchBlockConnection;
    originalMethods.isActivated = categoryUpdater.isActivated;

    categoryUpdater.getConnectionIPSetName = function(category) {
      return 'test_conn_set';
    };
    
    Block.batchBlockConnection = function() {
      callCounts.batchBlockConnection++;
      return Promise.reject(new Error('Block error'));
    };
    
    categoryUpdater.isActivated = function(category) {
      return true;
    };

    // Should not throw
    await categoryUpdater.processSignatureData(sigData);

    expect(callCounts.batchBlockConnection).to.equal(1);
  });

  it('should handle errors from addSigDetectedServer gracefully', async () => {
    const sigData = {
      sigId: 'test_sig',
      remoteAddr: '1.2.3.4',
      remotePorts: [443]
    };

    categoryUpdater.flowSignatureConfig = {
      'test_sig': {
        categories: ['test_category'],
        blockType: 'ipPort',
        proto: 'tcp'
      }
    };

    originalMethods.addSigDetectedServer = categoryUpdater.addSigDetectedServer;

    categoryUpdater.addSigDetectedServer = function() {
      callCounts.addSigDetectedServer++;
      return Promise.reject(new Error('Add server error'));
    };

    // Should not throw
    await categoryUpdater.processSignatureData(sigData);

    expect(callCounts.addSigDetectedServer).to.equal(1);
  });
});




describe('Test CategoryUpdater.updateFlowSignatureList', function() {
  this.timeout(10000);
  
  let categoryUpdater;
  let originalMethods = {};
  let callCounts = {};
  let capturedCalls = {};

  beforeEach(async () => {
    categoryUpdater = new CategoryUpdater();
    
    // Reset flowSignatureConfig
    categoryUpdater.flowSignatureConfig = {};
    
    // Reset effectiveCategorySigDtSrvs
    categoryUpdater.effectiveCategorySigDtSrvs = new Map();
    
    // Reset call counts
    callCounts = {
      rclientGetAsync: 0,
      removeSigDtServer: 0
    };
    
    capturedCalls = {
      removeSigDtServer: []
    };
  });

  afterEach(() => {
    // Restore original methods
    if (originalMethods.rclientGetAsync) {
      rclient.getAsync = originalMethods.rclientGetAsync;
    }
    if (originalMethods.removeSigDtServer) {
      categoryUpdater.removeSigDtServer = originalMethods.removeSigDtServer;
    }
    originalMethods = {};
  });

  it('should return early when flow signature config is not found in redis', async () => {
    // Save original method
    originalMethods.rclientGetAsync = rclient.getAsync;

    // Stub to return null
    rclient.getAsync = function(key) {
      callCounts.rclientGetAsync++;
      if (key === Constants.REDIS_KEY_FLOW_SIGNATURE_CLOUD_CONFIG) {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    };

    await categoryUpdater.updateFlowSignatureList();

    expect(callCounts.rclientGetAsync).to.equal(1);
    expect(categoryUpdater.flowSignatureConfig).to.deep.equal({});
  });

  it('should return early when redis getAsync throws an error', async () => {
    // Save original method
    originalMethods.rclientGetAsync = rclient.getAsync;

    // Stub to throw error
    rclient.getAsync = function(key) {
      callCounts.rclientGetAsync++;
      if (key === Constants.REDIS_KEY_FLOW_SIGNATURE_CLOUD_CONFIG) {
        return Promise.reject(new Error('Redis error'));
      }
      return Promise.resolve(null);
    };

    await categoryUpdater.updateFlowSignatureList();

    expect(callCounts.rclientGetAsync).to.equal(1);
    expect(categoryUpdater.flowSignatureConfig).to.deep.equal({});
  });

  it('should update flowSignatureConfig when new config is provided', async () => {
    const newConfig = {
      'sig1': {
        categories: ['porn'],
        blockType: 'connection'
      }
    };

    // Save original method
    originalMethods.rclientGetAsync = rclient.getAsync;

    // Stub to return new config
    rclient.getAsync = function(key) {
      callCounts.rclientGetAsync++;
      if (key === Constants.REDIS_KEY_FLOW_SIGNATURE_CLOUD_CONFIG) {
        return Promise.resolve(JSON.stringify(newConfig));
      }
      return Promise.resolve(null);
    };

    await categoryUpdater.updateFlowSignatureList();

    expect(callCounts.rclientGetAsync).to.equal(1);
    expect(categoryUpdater.flowSignatureConfig).to.deep.equal(newConfig);
  });

  it('should remove servers when a signature is removed from config', async () => {
    // Setup original config with a signature
    categoryUpdater.flowSignatureConfig = {
      'sig1': {
        categories: ['test_category'],
        blockType: 'connection'
      }
    };

    // Setup effectiveCategorySigDtSrvs with entries for sig1
    const serverEntry1 = {
      sigId: 'sig1',
      id: '1.2.3.4',
      port: { start: 443, end: 443, proto: 'tcp' },
      category: 'test_category'
    };
    const serverEntry2 = {
      sigId: 'sig1',
      id: '5.6.7.8',
      port: { start: 80, end: 80, proto: 'tcp' },
      category: 'test_category'
    };

    const categoryMap = new Map();
    const sigIdMap = new Map();
    sigIdMap.set(categoryUpdater.getSigDtSvrKey(serverEntry1), serverEntry1);
    sigIdMap.set(categoryUpdater.getSigDtSvrKey(serverEntry2), serverEntry2);
    categoryMap.set('sig1', sigIdMap);
    categoryUpdater.effectiveCategorySigDtSrvs.set('test_category', categoryMap);

    // New config without sig1
    const newConfig = {
      'sig2': {
        categories: ['test_category2'],
        blockType: 'connection'
      }
    };

    // Save original methods
    originalMethods.rclientGetAsync = rclient.getAsync;
    originalMethods.removeSigDtServer = categoryUpdater.removeSigDtServer;

    // Stub methods
    rclient.getAsync = function(key) {
      callCounts.rclientGetAsync++;
      if (key === Constants.REDIS_KEY_FLOW_SIGNATURE_CLOUD_CONFIG) {
        return Promise.resolve(JSON.stringify(newConfig));
      }
      return Promise.resolve(null);
    };

    categoryUpdater.removeSigDtServer = function(category, serverEntry) {
      callCounts.removeSigDtServer++;
      capturedCalls.removeSigDtServer.push({ category, serverEntry });
      return Promise.resolve();
    };

    await categoryUpdater.updateFlowSignatureList();

    expect(callCounts.rclientGetAsync).to.equal(1);
    expect(callCounts.removeSigDtServer).to.equal(2);
    expect(capturedCalls.removeSigDtServer.length).to.equal(2);
    expect(capturedCalls.removeSigDtServer[0].category).to.equal('test_category');
    expect(capturedCalls.removeSigDtServer[0].serverEntry).to.deep.equal(serverEntry1);
    expect(capturedCalls.removeSigDtServer[1].category).to.equal('test_category');
    expect(capturedCalls.removeSigDtServer[1].serverEntry).to.deep.equal(serverEntry2);
    
    // Verify effectiveCategorySigDtSrvs is cleaned up
    expect(categoryUpdater.effectiveCategorySigDtSrvs.has('test_category')).to.be.false;
    expect(categoryUpdater.flowSignatureConfig).to.deep.equal(newConfig);
  });

  it('should handle signature with multiple categories', async () => {
    // Setup original config
    categoryUpdater.flowSignatureConfig = {
      'sig1': {
        categories: ['test_category1', 'test_category2'],
        blockType: 'connection'
      }
    };

    // Setup effectiveCategorySigDtSrvs for both categories
    const serverEntry1 = {
      sigId: 'sig1',
      id: '1.2.3.4',
      port: { start: 443, end: 443, proto: 'tcp' },
      category: 'test_category1'
    };
    const serverEntry2 = {
      sigId: 'sig1',
      id: '5.6.7.8',
      port: { start: 80, end: 80, proto: 'tcp' },
      category: 'test_category2'
    };

    const testCategory1Map = new Map();
    const testCategory1SigIdMap = new Map();
    testCategory1SigIdMap.set(categoryUpdater.getSigDtSvrKey(serverEntry1), serverEntry1);
    testCategory1Map.set('sig1', testCategory1SigIdMap);
    categoryUpdater.effectiveCategorySigDtSrvs.set('test_category1', testCategory1Map);

    const testCategory2Map = new Map();
    const testCategory2SigIdMap = new Map();
    testCategory2SigIdMap.set(categoryUpdater.getSigDtSvrKey(serverEntry2), serverEntry2);
    testCategory2Map.set('sig1', testCategory2SigIdMap);
    categoryUpdater.effectiveCategorySigDtSrvs.set('test_category2', testCategory2Map);

    // New config without sig1
    const newConfig = {};

    // Save original methods
    originalMethods.rclientGetAsync = rclient.getAsync;
    originalMethods.removeSigDtServer = categoryUpdater.removeSigDtServer;

    rclient.getAsync = function(key) {
      if (key === Constants.REDIS_KEY_FLOW_SIGNATURE_CLOUD_CONFIG) {
        return Promise.resolve(JSON.stringify(newConfig));
      }
      return Promise.resolve(null);
    };

    categoryUpdater.removeSigDtServer = function(category, serverEntry) {
      callCounts.removeSigDtServer++;
      capturedCalls.removeSigDtServer.push({ category, serverEntry });
      return Promise.resolve();
    };

    await categoryUpdater.updateFlowSignatureList();

    expect(callCounts.removeSigDtServer).to.equal(2);
    expect(capturedCalls.removeSigDtServer[0].category).to.equal('test_category1');
    expect(capturedCalls.removeSigDtServer[1].category).to.equal('test_category2');
    
    // Verify both categories are cleaned up
    expect(categoryUpdater.effectiveCategorySigDtSrvs.has('test_category1')).to.be.false;
    expect(categoryUpdater.effectiveCategorySigDtSrvs.has('test_category2')).to.be.false;
    expect(categoryUpdater.flowSignatureConfig).to.deep.equal(newConfig);
    expect(capturedCalls.removeSigDtServer[0].category).to.equal('test_category1');
    expect(capturedCalls.removeSigDtServer[0].serverEntry).to.deep.equal(serverEntry1);
    expect(capturedCalls.removeSigDtServer[1].category).to.equal('test_category2');
    expect(capturedCalls.removeSigDtServer[1].serverEntry).to.deep.equal(serverEntry2);
  });

  it('should handle when signature block type is changed from ipPort to connection', async () => {
    // Setup original config
    categoryUpdater.flowSignatureConfig = {
      'sig1': {
        categories: ['test_category'],
        blockType: 'ipPort'
      }
    };

    // Setup effectiveCategorySigDtSrvs with entries for sig1
    const serverEntry1 = {
      sigId: 'sig1',
      id: '1.2.3.4',
      port: { start: 443, end: 443, proto: 'tcp' },
      category: 'test_category'
    };
    const testCategoryMap = new Map();
    const testCategorySigIdMap = new Map();
    testCategorySigIdMap.set(categoryUpdater.getSigDtSvrKey(serverEntry1), serverEntry1);
    testCategoryMap.set('sig1', testCategorySigIdMap);
    categoryUpdater.effectiveCategorySigDtSrvs.set('test_category', testCategoryMap);

    // New config with sig1 still present plus new sig2
    const newConfig = {
      'sig1': {
        categories: ['test_category'],
        blockType: 'connection'
      }
    };

    // Save original methods
    originalMethods.rclientGetAsync = rclient.getAsync;
    originalMethods.removeSigDtServer = categoryUpdater.removeSigDtServer;

    rclient.getAsync = function(key) {
      if (key === Constants.REDIS_KEY_FLOW_SIGNATURE_CLOUD_CONFIG) {
        return Promise.resolve(JSON.stringify(newConfig));
      }
      return Promise.resolve(null);
    };

    categoryUpdater.removeSigDtServer = function(category, serverEntry) {
      callCounts.removeSigDtServer++;
      capturedCalls.removeSigDtServer.push({ category, serverEntry });
      return Promise.resolve();
    };

    await categoryUpdater.updateFlowSignatureList();

    expect(callCounts.removeSigDtServer).to.equal(1);
    expect(capturedCalls.removeSigDtServer[0].category).to.equal('test_category');
    expect(capturedCalls.removeSigDtServer[0].serverEntry).to.deep.equal(serverEntry1);
    expect(categoryUpdater.flowSignatureConfig).to.deep.equal(newConfig);
  });


  it('should handle when effectiveCategorySigDtSrvs has no entry for removed signature', async () => {
    // Setup original config
    categoryUpdater.flowSignatureConfig = {
      'sig1': {
        categories: ['test_category'],
        blockType: 'connection'
      }
    };

    // effectiveCategorySigDtSrvs is empty (no entries for sig1)
    categoryUpdater.effectiveCategorySigDtSrvs = new Map();

    // New config without sig1
    const newConfig = {};

    // Save original methods
    originalMethods.rclientGetAsync = rclient.getAsync;
    originalMethods.removeSigDtServer = categoryUpdater.removeSigDtServer;

    rclient.getAsync = function(key) {
      if (key === Constants.REDIS_KEY_FLOW_SIGNATURE_CLOUD_CONFIG) {
        return Promise.resolve(JSON.stringify(newConfig));
      }
      return Promise.resolve(null);
    };

    categoryUpdater.removeSigDtServer = function() {
      callCounts.removeSigDtServer++;
      return Promise.resolve();
    };

    await categoryUpdater.updateFlowSignatureList();

    // Should not call removeSigDtServer when there are no entries
    expect(callCounts.removeSigDtServer).to.equal(0);
    expect(categoryUpdater.flowSignatureConfig).to.deep.equal(newConfig);
  });

  it('should clean up empty category maps after removing all signatures', async () => {
    // Setup original config
    categoryUpdater.flowSignatureConfig = {
      'sig1': {
        categories: ['test_category'],
        blockType: 'connection'
      }
    };

    // Setup effectiveCategorySigDtSrvs with category but without sig1
    const categoryMap = new Map();
    const sigIdMap = new Map();
    const serverEntry = { sigId: 'sig1', address: '4.4.4.4', port: { start: 443, end: 443 }, proto: 'tcp' };
    sigIdMap.set(categoryUpdater.getSigDtSvrKey(serverEntry), serverEntry);
    categoryMap.set('sig1', sigIdMap);
    categoryUpdater.effectiveCategorySigDtSrvs.set('test_category', categoryMap);

    // New config without sig1
    const newConfig = {};

    // Save original methods
    originalMethods.rclientGetAsync = rclient.getAsync;
    originalMethods.removeSigDtServer = categoryUpdater.removeSigDtServer;

    rclient.getAsync = function(key) {
      if (key === Constants.REDIS_KEY_FLOW_SIGNATURE_CLOUD_CONFIG) {
        return Promise.resolve(JSON.stringify(newConfig));
      }
      return Promise.resolve(null);
    };

    categoryUpdater.removeSigDtServer = function(category, serverEntry) {
      callCounts.removeSigDtServer++;
      capturedCalls.removeSigDtServer.push({ category, serverEntry });
      return Promise.resolve();
    };

    await categoryUpdater.updateFlowSignatureList();

    // Should call removeSigDtServer
    expect(callCounts.removeSigDtServer).to.equal(1);
    expect(categoryUpdater.effectiveCategorySigDtSrvs.has('test_category')).to.be.false;
    expect(capturedCalls.removeSigDtServer.length).to.equal(1);
    expect(capturedCalls.removeSigDtServer[0].category).to.equal('test_category');
    expect(capturedCalls.removeSigDtServer[0].serverEntry).to.deep.equal(serverEntry);
    expect(categoryUpdater.flowSignatureConfig).to.deep.equal(newConfig);
  });


  it('should handle multiple signatures being removed', async () => {
    // Setup original config with multiple signatures
    categoryUpdater.flowSignatureConfig = {
      'sig1': {
        categories: ['test_category1'],
        blockType: 'connection'
      },
      'sig2': {
        categories: ['test_category2'],
        blockType: 'ipPort'
      }
    };

    // Setup effectiveCategorySigDtSrvs for both signatures
    const serverEntry1 = {
      sigId: 'sig1',
      id: '1.2.3.4',
      port: { start: 443, end: 443, proto: 'tcp' },
      category: 'test_category1'
    };
    const serverEntry2 = {
      sigId: 'sig2',
      id: '5.6.7.8',
      port: { start: 80, end: 80, proto: 'tcp' },
      category: 'test_category2'
    };

    const testCategory1Map = new Map();
    const testCategory1SigIdMap = new Map();
    testCategory1SigIdMap.set(categoryUpdater.getSigDtSvrKey(serverEntry1), serverEntry1);
    testCategory1Map.set('sig1', testCategory1SigIdMap);
    categoryUpdater.effectiveCategorySigDtSrvs.set('test_category1', testCategory1Map);

    const testCategory2Map = new Map();
    const testCategory2SigIdMap = new Map();
    testCategory2SigIdMap.set(categoryUpdater.getSigDtSvrKey(serverEntry2), serverEntry2);
    testCategory2Map.set('sig2', testCategory2SigIdMap);
    categoryUpdater.effectiveCategorySigDtSrvs.set('test_category2', testCategory2Map);

    // New config without both signatures
    const newConfig = {};

    // Save original methods
    originalMethods.rclientGetAsync = rclient.getAsync;
    originalMethods.removeSigDtServer = categoryUpdater.removeSigDtServer;

    rclient.getAsync = function(key) {
      if (key === Constants.REDIS_KEY_FLOW_SIGNATURE_CLOUD_CONFIG) {
        return Promise.resolve(JSON.stringify(newConfig));
      }
      return Promise.resolve(null);
    };

    categoryUpdater.removeSigDtServer = function() {
      callCounts.removeSigDtServer++;
      return Promise.resolve();
    };

    await categoryUpdater.updateFlowSignatureList();

    expect(callCounts.removeSigDtServer).to.equal(2);
    expect(categoryUpdater.effectiveCategorySigDtSrvs.has('test_category1')).to.be.false;
    expect(categoryUpdater.effectiveCategorySigDtSrvs.has('test_category2')).to.be.false;
    expect(categoryUpdater.flowSignatureConfig).to.deep.equal(newConfig);
  });

  it('should update config when signatures are added but not removed', async () => {
    // Setup original config
    categoryUpdater.flowSignatureConfig = {
      'sig1': {
        categories: ['test_category1'],
        blockType: 'connection'
      }
    };

    // New config with sig1 still present plus new sig2
    const newConfig = {
      'sig1': {
        categories: ['test_category1'],
        blockType: 'connection'
      },
      'sig2': {
        categories: ['test_category2'],
        blockType: 'ipPort'
      }
    };

    // Save original methods
    originalMethods.rclientGetAsync = rclient.getAsync;
    originalMethods.removeSigDtServer = categoryUpdater.removeSigDtServer;

    rclient.getAsync = function(key) {
      if (key === Constants.REDIS_KEY_FLOW_SIGNATURE_CLOUD_CONFIG) {
        return Promise.resolve(JSON.stringify(newConfig));
      }
      return Promise.resolve(null);
    };

    categoryUpdater.removeSigDtServer = function() {
      callCounts.removeSigDtServer++;
      return Promise.resolve();
    };

    await categoryUpdater.updateFlowSignatureList();

    // Should not call removeSigDtServer since no signatures were removed
    expect(callCounts.removeSigDtServer).to.equal(0);
    expect(categoryUpdater.flowSignatureConfig).to.deep.equal(newConfig);
  });
});