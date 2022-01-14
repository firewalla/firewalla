const log = require('../net2/logger.js')(__filename);
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const f = require('../net2/Firewalla.js');
const PcapPlugin = require('./PcapPlugin.js');
const _ = require('lodash');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const mkdirp = Promise.promisify(require('mkdirp'));
const YAML = require('../vendor_lib/yaml');
const suricataControl = require('../net2/SuricataControl.js');
const sysManager = require('../net2/SysManager.js');

class PcapSuricataPlugin extends PcapPlugin {

  async initLogProcessing() {
    // not implemented yet
    const sd = require('../net2/SuricataDetect.js');
    await sd.initWatchers();
  }

  async restart() {
    const yaml = await this.generateSuricataYAML();
    await suricataControl.cleanupRuntimeConfig();
    await suricataControl.writeSuricataYAML(yaml);
    await suricataControl.prepareAssets();
    const listenInterfaces = await this.calculateListenInterfaces();
    await fs.writeFileAsync(`${f.getRuntimeInfoFolder()}/suricata/listen_interfaces.rc`, `LISTEN_INTERFACES="${Object.keys(listenInterfaces).join(" ")}"`, {encoding: "utf8"});
    await suricataControl.restart().then(() => suricataControl.addCronJobs()).then(() => {
      log.info("Suricata restarted");
    });
  }

  async stop() {
    await suricataControl.stop();
    await suricataControl.removeCronJobs();
  }

  getLocalSubnets() {
    const subnets = ["224.0.0.0/4", "ff00::/8"];
    const monitoringIntfs = sysManager.getMonitoringInterfaces();
    for (const intf of monitoringIntfs) {
      if (_.isArray(intf.ip4_subnets))
        Array.prototype.push.apply(subnets, intf.ip4_subnets);
      if (_.isArray(intf.ip6_subnets))
        Array.prototype.push.apply(subnets, intf.ip6_subnets);
    }
    return subnets;
  }

  async generateSuricataYAML() {
    const commonConfig = await fs.readFileAsync(`${f.getFirewallaHome()}/etc/suricata/suricata.yaml`, {encoding: "utf8"}).then(content => YAML.parse(content)).catch((err) => {
      log.error("Failed to read common suricata yaml config", err.message);
      return null;
    });
    if (!commonConfig)
      return;
    const platformConfig = await fs.readFileAsync(platform.getSuricataYAMLPath(), {encoding: "utf8"}).then(content => YAML.parse(content)).catch((err) => {
      log.error("Failed to read platform-specific suricata yaml config", err.message);
      return null;
    });
    if (!platformConfig)
      return;
    await mkdirp(`${f.getUserConfigFolder()}/suricata/`).catch((err) => {});
    const userConfig = await fs.readFileAsync(`${f.getUserConfigFolder()}/suricata/suricata.yaml`, {encoding: "utf8"}).then(content => YAML.parse(content)).catch((err) => {return {}});
    const finalConfig = Object.assign({}, commonConfig, platformConfig, userConfig);
    if (finalConfig && finalConfig["vars"] && finalConfig["vars"]["address-groups"] && finalConfig["vars"]["address-groups"]["HOME_NET"]) {
      const localSubnets = this.getLocalSubnets();
      finalConfig["vars"]["address-groups"]["HOME_NET"] = localSubnets.join(",")
    }
    const listenInterfaces = await this.calculateListenInterfaces();
    const afpacketConfigs = [];
    const pfringConfigs = [];
    const intfs = Object.keys(listenInterfaces);
    for (let i in intfs) {
      const intf = intfs[i];
      afpacketConfigs.push({
        "interface": intf,
        "cluster-id": 99 - i,
        "cluster-type": "cluster_flow",
        "defrag": true,
        "use-mmap": true,
        "tpacket-v3": true,
        "block-size": 65536,
        "buffer-size": 65536,
        "bpf-filter": "not port 5353"
      });
      pfringConfigs.push({
        "interface": intf,
        "threads": "auto",
        "cluster-id": 99 - i,
        "cluster-type": "cluster_flow",
        "bpf-filter": "not port 5353"
      });
    }
    if (finalConfig && finalConfig["af-packet"] && _.isArray(finalConfig["af-packet"]))
      Array.prototype.push.apply(finalConfig["af-packet"], afpacketConfigs);
    if (finalConfig && finalConfig["pfring"] && _.isArray(finalConfig["pfring"]))
      Array.prototype.push.apply(finalConfig["pfring"], pfringConfigs);
    return finalConfig;
  }

  async isSupported() {
    return fs.accessAsync(`/usr/bin/suricata`, fs.constants.F_OK).then(() => true).catch((err) => false);
  }

  getFeatureName() {
    return "pcap_suricata";
  }
}

module.exports = PcapSuricataPlugin;