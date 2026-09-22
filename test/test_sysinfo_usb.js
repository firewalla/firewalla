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
'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire');

// lsusb lines captured from real boxes
const LSUSB = {
  rootHub2: 'Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub',
  rootHub3: 'Bus 002 Device 001: ID 1d6b:0003 Linux Foundation 3.0 root hub',
  internalHub: 'Bus 001 Device 002: ID 05e3:0610 Genesys Logic, Inc. Hub',
  btDongle: 'Bus 001 Device 003: ID 0bda:a729 Realtek Semiconductor Corp. Bluetooth Radio',
  btDongleCSR: 'Bus 001 Device 003: ID 0a12:0001 Cambridge Silicon Radio, Ltd Bluetooth Dongle (HCI mode)',
  wifiDongle: 'Bus 001 Device 004: ID 0bda:c820 Realtek Semiconductor Corp. 802.11ac NIC',
  // same RTL8821CU family as c820, this is the one a gold reported
  wifiDongleC811: 'Bus 001 Device 003: ID 0bda:c811 Realtek Semiconductor Corp. 802.11ac NIC',
  // eth0 of pse, a NIC of the box rather than an accessory
  nativeNic: 'Bus 005 Device 002: ID 0bda:8153 Realtek Semiconductor Corp. RTL8153 Gigabit Ethernet Adapter',
  flashDrive: 'Bus 001 Device 006: ID 0781:5583 SanDisk Corp. Ultra Fit',
};

// a virtual /sys that answers readdir/readFile/access, dirs map to their entries
function fakeFs(tree) {
  const enoent = (path) => {
    const err = new Error(`ENOENT: no such file or directory, ${path}`);
    err.code = 'ENOENT';
    return err;
  };
  return {
    constants: { F_OK: 0 },
    promises: {
      readdir: async (path) => {
        if (!(path in tree.dirs)) throw enoent(path);
        return tree.dirs[path];
      },
      readFile: async (path) => {
        if (!(path in tree.files)) throw enoent(path);
        return tree.files[path];
      },
      access: async (path) => {
        if (!(path in tree.dirs) && !(path in tree.files)) throw enoent(path);
      },
    },
  };
}

const USB_DIR = '/sys/bus/usb/devices';

function newTree() {
  return { dirs: { [USB_DIR]: [], '/sys/class/net': [] }, files: {} };
}

// lays out one USB device the way the kernel exposes it, interfaces are
// [{cls, subClass, protocol, net, bluetooth}]
function addUsbDevice(tree, { dir, busnum, devnum, deviceClass = '00', interfaces = [] }) {
  tree.dirs[USB_DIR].push(dir);
  const devDir = `${USB_DIR}/${dir}`;
  tree.dirs[devDir] = [];
  tree.files[`${devDir}/busnum`] = `${busnum}\n`;
  tree.files[`${devDir}/devnum`] = `${devnum}\n`;
  tree.files[`${devDir}/bDeviceClass`] = `${deviceClass}\n`;
  interfaces.forEach((intf, i) => {
    const name = `${dir}:1.${i}`;
    tree.dirs[USB_DIR].push(name); // interface dirs are listed next to the device dirs
    tree.dirs[devDir].push(name);
    const ifDir = `${devDir}/${name}`;
    tree.dirs[ifDir] = [];
    tree.files[`${ifDir}/bInterfaceClass`] = `${intf.cls}\n`;
    tree.files[`${ifDir}/bInterfaceSubClass`] = `${intf.subClass || '00'}\n`;
    tree.files[`${ifDir}/bInterfaceProtocol`] = `${intf.protocol || '00'}\n`;
    if (intf.net)
      tree.dirs[`${ifDir}/net`] = [intf.net];
    if (intf.bluetooth)
      tree.dirs[`${ifDir}/bluetooth`] = ['hci0'];
  });
  return tree;
}

// a netdev of the box, wireless ones have a wireless directory
function addNetdev(tree, name, wireless) {
  tree.dirs['/sys/class/net'].push(name);
  tree.dirs[`/sys/class/net/${name}`] = wireless ? ['wireless'] : [];
  if (wireless)
    tree.dirs[`/sys/class/net/${name}/wireless`] = [];
}

// loads SysInfo.js with lsusb answered from `lines`, /sys from `tree` and the NICs of the
// platform from `nicNames`. lsusb rejects when lines is null, the way it does when not installed
function loadSysInfo(lines, tree = newTree(), nicNames = ['eth0', 'eth1', 'wlan0', 'wlan1'], nativeIds = []) {
  let lsusbCalls = 0;
  const sysInfo = proxyquire('../extension/sysinfo/SysInfo.js', {
    'child-process-promise': {
      exec: async (cmd) => {
        if (cmd !== 'lsusb')
          throw new Error(`Command failed: ${cmd}`);
        lsusbCalls++;
        if (lines === null)
          throw new Error('Command failed: lsusb');
        return { stdout: lines.join('\n') + '\n', stderr: '' };
      },
    },
    'fs': fakeFs(tree),
    '../../platform/PlatformLoader.js': {
      getPlatform: () => ({
        getAllNicNames: () => nicNames,
        getNativeUsbDeviceIds: () => nativeIds,
        isDockerSupported: () => false,
      }),
    },
  });
  return { sysInfo, lsusbCalls: () => lsusbCalls };
}

describe('SysInfo.getUsbInfo', function () {
  this.timeout(10000);

  it('should detect a bluetooth dongle, a wifi dongle and skip hubs', async () => {
    const tree = newTree();
    addUsbDevice(tree, { dir: '1-0:1.0', busnum: 1, devnum: 1, deviceClass: '09' });
    addUsbDevice(tree, { dir: '1-1', busnum: 1, devnum: 2, deviceClass: '09' });
    // btusb brought up hci0 on the wireless interface of the dongle
    addUsbDevice(tree, { dir: '1-1.1', busnum: 1, devnum: 3, deviceClass: 'e0',
      interfaces: [{ cls: 'e0', subClass: '01', protocol: '01', bluetooth: true }] });
    // the wifi dongle uses a vendor specific class, wlan0 is what gives it away
    addUsbDevice(tree, { dir: '1-1.2', busnum: 1, devnum: 4,
      interfaces: [{ cls: 'ff', net: 'wlan0' }] });
    addNetdev(tree, 'wlan0', true);

    const { sysInfo } = loadSysInfo([LSUSB.rootHub2, LSUSB.internalHub, LSUSB.btDongle, LSUSB.wifiDongle], tree);
    expect(await sysInfo.getUsbInfo()).to.deep.equal({
      bluetooth: true,
      wifi: true,
      other: false,
      devices: [
        { id: '0bda:a729', name: 'Realtek Semiconductor Corp. Bluetooth Radio', types: ['bluetooth'] },
        { id: '0bda:c820', name: 'Realtek Semiconductor Corp. 802.11ac NIC', types: ['wifi'] },
      ],
    });
  });

  it('should classify an unknown device as other without a type of its own', async () => {
    const tree = newTree();
    addUsbDevice(tree, { dir: '1-1', busnum: 1, devnum: 6, interfaces: [{ cls: '08', subClass: '06', protocol: '50' }] });

    const { sysInfo } = loadSysInfo([LSUSB.rootHub2, LSUSB.flashDrive], tree);
    expect(await sysInfo.getUsbInfo()).to.deep.equal({
      bluetooth: false,
      wifi: false,
      other: true,
      devices: [{ id: '0781:5583', name: 'SanDisk Corp. Ultra Fit', types: ['other'] }],
    });
  });

  it('should ignore a NIC of the box that sits on the USB bus', async () => {
    const tree = newTree();
    // pse: eth0 is a RTL8153 on the USB bus, both it and the wifi dongle use a vendor
    // specific class, only the netdev they bring up tells them apart
    addUsbDevice(tree, { dir: '5-1', busnum: 5, devnum: 2, interfaces: [{ cls: 'ff', subClass: 'ff', net: 'eth0' }] });
    addUsbDevice(tree, { dir: '4-1', busnum: 4, devnum: 2, interfaces: [{ cls: 'ff', net: 'wlan0' }] });
    addNetdev(tree, 'eth0', false);
    addNetdev(tree, 'wlan0', true);

    const usbInfo = await loadSysInfo([LSUSB.rootHub2, LSUSB.nativeNic, LSUSB.wifiDongle], tree).sysInfo.getUsbInfo();
    expect(usbInfo.wifi).to.be.true;
    expect(usbInfo.other).to.be.false;
    expect(usbInfo.devices.map(d => d.id)).to.deep.equal(['0bda:c820']);
  });

  it('should ignore a native NIC listed by the platform even without its driver', async () => {
    // r8152 did not come up, so there is no netdev to recognize eth0 of pse by
    const tree = newTree();
    addUsbDevice(tree, { dir: '5-1', busnum: 5, devnum: 2, interfaces: [{ cls: 'ff', subClass: 'ff' }] });

    const { sysInfo } = loadSysInfo([LSUSB.nativeNic], tree, ['eth0', 'eth1', 'wlan0', 'wlan1'], ['0bda:8153']);
    const usbInfo = await sysInfo.getUsbInfo();
    expect(usbInfo.other).to.be.false;
    expect(usbInfo.devices).to.be.empty;
  });

  it('should not report the built-in bluetooth of a platform as an accessory', async () => {
    // pse: the CSR8510 is soldered in and looks exactly like the dongle plugged into a gold,
    // only the platform can tell that it is not an accessory here
    const tree = newTree();
    addUsbDevice(tree, { dir: '4-1', busnum: 4, devnum: 2, deviceClass: 'e0',
      interfaces: [{ cls: 'e0', subClass: '01', protocol: '01', bluetooth: true }] });
    addUsbDevice(tree, { dir: '2-1', busnum: 2, devnum: 2, interfaces: [{ cls: 'ff', net: 'wlan0' }] });
    addNetdev(tree, 'wlan0', true);

    const lines = [LSUSB.rootHub2, LSUSB.btDongleCSR, LSUSB.wifiDongleC811];
    const nics = ['eth0', 'eth1', 'wlan0', 'wlan1'];
    const { sysInfo } = loadSysInfo(lines, tree, nics, ['0bda:8153', '0a12:0001']);
    expect(await sysInfo.getUsbInfo()).to.deep.equal({
      bluetooth: false,
      wifi: true,
      other: false,
      devices: [{ id: '0bda:c811', name: 'Realtek Semiconductor Corp. 802.11ac NIC', types: ['wifi'] }],
    });

    // the same box without the platform entry, i.e. a gold, does report it
    const gold = loadSysInfo(lines, tree, nics);
    expect((await gold.sysInfo.getUsbInfo()).bluetooth).to.be.true;
  });

  it('should report a combo dongle as both bluetooth and wifi', async () => {
    const tree = newTree();
    addUsbDevice(tree, { dir: '1-1', busnum: 1, devnum: 3, interfaces: [
      { cls: 'ff', net: 'wlan1' },
      { cls: 'e0', subClass: '01', protocol: '01', bluetooth: true },
    ]});
    addNetdev(tree, 'wlan1', true);

    const usbInfo = await loadSysInfo([LSUSB.btDongle], tree).sysInfo.getUsbInfo();
    expect(usbInfo.bluetooth).to.be.true;
    expect(usbInfo.wifi).to.be.true;
    expect(usbInfo.devices).to.have.lengthOf(1);
    expect(usbInfo.devices[0].types).to.deep.equal(['bluetooth', 'wifi']);
  });

  it('should detect the dongles by their id when their driver did not come up', async () => {
    // no interface is bound, so there is neither a hci nor a wlan device to look at
    const tree = newTree();
    addUsbDevice(tree, { dir: '1-1', busnum: 1, devnum: 3, interfaces: [{ cls: 'ff' }] });
    addUsbDevice(tree, { dir: '1-2', busnum: 1, devnum: 4, interfaces: [{ cls: 'ff' }] });

    const usbInfo = await loadSysInfo([LSUSB.btDongleCSR, LSUSB.wifiDongleC811], tree).sysInfo.getUsbInfo();
    expect(usbInfo.bluetooth).to.be.true;
    expect(usbInfo.wifi).to.be.true;
    expect(usbInfo.other).to.be.false;
  });

  it('should fall back to the lsusb output alone when sysfs is not readable', async () => {
    const { sysInfo } = loadSysInfo(
      [LSUSB.rootHub2, LSUSB.rootHub3, LSUSB.internalHub, LSUSB.btDongle],
      { dirs: {}, files: {} }
    );
    const usbInfo = await sysInfo.getUsbInfo();
    // hubs are still recognized by the root hub vendor and by their product string
    expect(usbInfo.bluetooth).to.be.true;
    expect(usbInfo.other).to.be.false;
    expect(usbInfo.devices).to.have.lengthOf(1);
  });

  it('should report nothing at all when lsusb is not available', async () => {
    const { sysInfo } = loadSysInfo(null);
    expect(await sysInfo.getUsbInfo()).to.be.null;
  });

  it('should cache the result instead of running lsusb on every call', async () => {
    const { sysInfo, lsusbCalls } = loadSysInfo([LSUSB.rootHub2, LSUSB.btDongle]);
    // concurrent callers share the one refresh, and the result is reused afterwards
    const [first, second] = await Promise.all([sysInfo.getUsbInfo(), sysInfo.getUsbInfo()]);
    expect(second).to.equal(first);
    expect(await sysInfo.getUsbInfo()).to.equal(first);
    expect(lsusbCalls()).to.equal(1);
  });
});
