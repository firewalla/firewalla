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
'use strict';

let chai = require('chai');
let expect = chai.expect;

let Nmap = require('../net2/Nmap');

describe('Test Nmap.parseNmapTextOutput', () => {
  
  describe('Simple scan without scripts', () => {
    it('should parse simple scan without scripts', () => {
      const simpleOutput = `Starting Nmap 7.94 ( https://nmap.org ) at 2025-11-14 19:06
Nmap scan report for 192.168.1.1
Host is up (0.00056s latency).
MAC Address: AA:BB:CC:DD:EE:FF (Test Vendor)
Nmap scan report for 192.168.1.2
Host is up.
Nmap done: 64 IP addresses (2 hosts up) scanned in 2.15 seconds`;

      const result = Nmap.parseNmapTextOutput(simpleOutput);
      expect(result.hosts).to.be.an('array');
      expect(result.hosts.length).to.equal(2);

      const host1 = result.hosts.find(h => h.ipv4Addr === '192.168.1.1');
      expect(host1).to.exist;
      expect(host1.mac).to.equal('AA:BB:CC:DD:EE:FF');
      expect(host1.macVendor).to.equal('Test Vendor');
      expect(host1.script).to.not.exist;

      const host2 = result.hosts.find(h => h.ipv4Addr === '192.168.1.2');
      expect(host2).to.exist;
      expect(host2.mac).to.be.null;
      expect(host2.script).to.not.exist;
    });
  });

  describe('Host with hostname', () => {
    const hostnameOutput = `Nmap scan report for router.local (192.168.1.1)
Host is up (0.001s latency).
MAC Address: AA:BB:CC:DD:EE:FF (Test Vendor)
Nmap done: 1 IP addresses (1 hosts up) scanned in 1.00 seconds`;

    it('should parse hostname and extract IP address', () => {
      const result = Nmap.parseNmapTextOutput(hostnameOutput);
      expect(result.hosts).to.be.an('array');
      expect(result.hosts.length).to.equal(1);
      
      const host = result.hosts[0];
      expect(host.ipv4Addr).to.equal('192.168.1.1');
      expect(host.mac).to.equal('AA:BB:CC:DD:EE:FF');
    });
  });

  describe('Empty network with only box itself', () => {
    const emptyNetworkOutput = `Starting Nmap 7.94 ( https://nmap.org ) at 2025-11-26 16:29
Nmap scan report for 192.168.128.1
Host is up.
Nmap done: 256 IP addresses (1 host up) scanned in 103.34 seconds`
    it('should parse empty network output', () => {
      const result = Nmap.parseNmapTextOutput(emptyNetworkOutput);
      expect(result.hosts).to.be.an('array');
      expect(result.hosts.length).to.equal(1);
      expect(result.hosts[0].ipv4Addr).to.equal('192.168.128.1');
      expect(result.hosts[0].mac).to.be.null;
      expect(result.hosts[0].script).to.not.exist;
    });
  });

  describe('Empty or invalid output', () => {
    it('should handle empty output', () => {
      const result = Nmap.parseNmapTextOutput('');
      expect(result.hosts).to.be.an('array');
      expect(result.hosts.length).to.equal(0);
    });

    it('should handle output with no hosts', () => {
      const output = `Starting Nmap 7.94 ( https://nmap.org ) at 2025-11-13 17:35
Nmap done: 256 IP addresses (0 hosts up) scanned in 8.05 seconds`;
      const result = Nmap.parseNmapTextOutput(output);
      expect(result.hosts).to.be.an('array');
      expect(result.hosts.length).to.equal(0);
    });
  });

  describe('Mac OUI', () => {
    it('should parse vendor names with parentheses', () => {
      const parenthesesOutput = `Starting Nmap 7.94 ( https://nmap.org ) at 2025-11-18 19:55
Nmap scan report for 192.168.1.3
Host is up (0.00080s latency).
MAC Address: 00:10:12:00:00:01 (PROCESSOR SYSTEMS (I) PVT LTD)
Nmap done: 1 IP address (1 host up) scanned in 0.16 seconds`;
      const result = Nmap.parseNmapTextOutput(parenthesesOutput);
      expect(result.hosts).to.be.an('array');
      expect(result.hosts.length).to.equal(1);
      const host = result.hosts[0];
      expect(host.ipv4Addr).to.equal('192.168.1.3');
      expect(host.mac).to.equal('00:10:12:00:00:01');
      expect(host.macVendor).to.equal('PROCESSOR SYSTEMS (I) PVT LTD');
      expect(host.script).to.not.exist;
    });

    it('should parse vendor names with parentheses', () => {
      const unicodeOutput = `Starting Nmap 7.94 ( https://nmap.org ) at 2025-11-19 13:07
Nmap scan report for 192.168.1.3
Host is up (0.00076s latency).
MAC Address: 3C:2C:94:00:00:01 (杭州德澜科技有限公司（HangZhou Delan Technology Co.,Ltd）)
Nmap done: 1 IP address (1 host up) scanned in 0.27 seconds`;
      const result = Nmap.parseNmapTextOutput(unicodeOutput);
      expect(result.hosts).to.be.an('array');
      expect(result.hosts.length).to.equal(1);
      const host = result.hosts[0];
      expect(host.ipv4Addr).to.equal('192.168.1.3');
      expect(host.mac).to.equal('3C:2C:94:00:00:01');
      expect(host.macVendor).to.equal('杭州德澜科技有限公司（HangZhou Delan Technology Co.,Ltd）');
      expect(host.script).to.not.exist;
    });
  });

  describe('Should parse v6 output', () => {
    const v6Output = `Starting Nmap 7.94 ( https://nmap.org ) at 2025-11-18 19:36
Nmap scan report for fe80::ce:163c:8a8:a3d4
Host is up (0.10s latency).
MAC Address: 7A:65:1E:1A:1D:0C (Unknown)
Nmap done: 1 IP address (1 host up) scanned in 0.27 seconds`;

    it('should parse v6 output', () => {
      const result = Nmap.parseNmapTextOutput(v6Output);
      expect(result.hosts).to.be.an('array');
      expect(result.hosts.length).to.equal(1);
      const host = result.hosts[0];
      expect(host.ipv6Addr).to.equal('fe80::ce:163c:8a8:a3d4');
      expect(host.mac).to.equal('7A:65:1E:1A:1D:0C');
      expect(host.macVendor).to.equal('Unknown');
      expect(host.script).to.not.exist;
    });
  });

  describe('nbstat.nse script output', () => {
    const nbstatOutput = `Starting Nmap 7.94 ( https://nmap.org ) at 2025-11-14 19:09
Nmap scan report for 192.168.1.1
Host is up (0.00012s latency).
Not shown: 984 closed tcp ports (reset)
PORT     STATE SERVICE
22/tcp   open  ssh
80/tcp   open  http
111/tcp  open  rpcbind
139/tcp  open  netbios-ssn
443/tcp  open  https
445/tcp  open  microsoft-ds
2049/tcp open  nfs
3261/tcp open  winshadow
3493/tcp open  nut
4045/tcp open  lockd
5000/tcp open  upnp
5001/tcp open  commplex-link
5357/tcp open  wsdapi
5566/tcp open  westec-connect
8080/tcp open  http-proxy
8443/tcp open  https-alt
MAC Address: 90:09:D0:00:00:00 (Synology Incorporated)

Host script results:
| nbstat: NetBIOS name: FIRENAS, NetBIOS user: <unknown>, NetBIOS MAC: <unknown> (unknown)
| Names:
|   FIRENAS<00>          Flags: <unique><active>
|   FIRENAS<03>          Flags: <unique><active>
|   FIRENAS<20>          Flags: <unique><active>
|   WORKGROUP<00>        Flags: <group><active>
|_  WORKGROUP<1e>        Flags: <group><active>

Nmap done: 1 IP address (1 host up) scanned in 1.04 seconds`;

    it('should parse nbstat output and extract NetBIOS name', () => {
      const result = Nmap.parseNmapTextOutput(nbstatOutput, 'nbstat.nse');
      expect(result.hosts).to.be.an('array');
      expect(result.hosts.length).to.equal(1);
      
      const host = result.hosts[0];
      expect(host.ipv4Addr).to.equal('192.168.1.1');
      expect(host.mac).to.equal('90:09:D0:00:00:00');
      expect(host.macVendor).to.equal('Synology Incorporated');
      expect(host.script).to.exist;
      // Verify scriptId extraction - nbstat stores data under 'nbtName', not scriptId
      expect(host.script['nbstat']).to.exist;
      expect(host.script['nbstat.nse']).to.not.exist;
      expect(host.script.nbstat.nbtName).to.equal('FIRENAS');
      
      // Test with full path - should still work correctly
      const fullPathResult = Nmap.parseNmapTextOutput(nbstatOutput, '/path/to/nbstat.nse');
      const fullPathHost = fullPathResult.hosts[0];
      expect(fullPathHost.script['nbstat'].nbtName).to.equal('FIRENAS');
      expect(fullPathHost.script['/path/to/nbstat.nse']).to.not.exist;
    });

    it('should fall back to first name in Names section if NetBIOS name is <unknown>', () => {
      const nbstatOutputUnknown = `Starting Nmap 7.94 ( https://nmap.org ) at 2025-11-14 19:10
Nmap scan report for 192.168.1.1
Host is up (0.00017s latency).
PORT STATE SERVICE
137/udp open netbios-ns
MAC Address: 90:09:D0:00:00:00 (Synology Incorporated)
Host script results:
| nbstat: NetBIOS name: <unknown>, NetBIOS user: <unknown>, NetBIOS MAC: <unknown> (unknown)
| Names:
|   FIRENAS<00>          Flags: <unique><active>
|   FIRENAS<03>          Flags: <unique><active>
|_  WORKGROUP<00>        Flags: <group><active>

Nmap done: 1 IP address (1 host up) scanned in 1.04 seconds`;

      const result = Nmap.parseNmapTextOutput(nbstatOutputUnknown, 'nbstat.nse');
      const host = result.hosts[0];
      expect(host.script.nbstat.nbtName).to.equal('FIRENAS');
    });
  });

  describe('Should parse vulnerability scan output', () => {
    const realWorldOutput = `Starting Nmap 7.94 ( https://nmap.org ) at 2025-11-13 17:35
Nmap scan report for 192.168.130.50
Host is up (0.00075s latency).
Not shown: 994 closed tcp ports (reset)
PORT     STATE SERVICE
22/tcp   open  ssh
53/tcp   open  domain
88/tcp   open  kerberos-sec
5000/tcp open  upnp
5900/tcp open  vnc
7000/tcp open  afs3-fileserver
MAC Address: 60:38:E0:00:00:01 (Belkin International Inc.)

Nmap scan report for 192.168.130.71
Host is up (0.00041s latency).
Not shown: 998 closed tcp ports (reset)
PORT   STATE SERVICE
22/tcp open  ssh
53/tcp open  domain
MAC Address: 20:6D:31:00:00:01 (FIREWALLA INC)

Nmap scan report for 192.168.130.142
Host is up (0.0042s latency).
Not shown: 995 filtered tcp ports (no-response)
PORT     STATE SERVICE
53/tcp   open  domain
135/tcp  open  msrpc
139/tcp  open  netbios-ssn
445/tcp  open  microsoft-ds
5357/tcp open  wsdapi
MAC Address: 5E:8D:D8:6C:F5:56 (Unknown)

Host script results:
| smb-vuln-ms17-010:
|   VULNERABLE:
|   Remote Code Execution vulnerability in Microsoft SMBv1 servers (ms17-010)
|     State: VULNERABLE
|     IDs:  CVE:CVE-2017-0143
|     Risk factor: HIGH
|       A critical remote code execution vulnerability exists in Microsoft SMBv1
|        servers (ms17-010).
|
|     Disclosure date: 2017-03-14
|     References:
|       https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2017-0143
|       https://technet.microsoft.com/en-us/library/security/ms17-010.aspx
|_      https://blogs.technet.microsoft.com/msrc/2017/05/12/customer-guidance-for-wannacrypt-attacks/

Nmap scan report for 192.168.130.1
Host is up (0.000057s latency).
Not shown: 997 closed tcp ports (reset)
PORT    STATE SERVICE
22/tcp  open  ssh
53/tcp  open  domain
111/tcp open  rpcbind

Nmap done: 256 IP addresses (4 hosts up) scanned in 7.99 seconds`;
    const result = Nmap.parseNmapTextOutput(realWorldOutput, 'smb-vuln-ms17-010.nse');

    it('should parse multiple hosts correctly', () => {
      expect(result.hosts).to.be.an('array');
      expect(result.hosts.length).to.equal(4);
    });

    it('should parse host 192.168.130.50 correctly', () => {
      const host = result.hosts.find(h => h.ipv4Addr === '192.168.130.50');
      expect(host).to.exist;
      expect(host.mac).to.equal('60:38:E0:00:00:01');
      expect(host.macVendor).to.equal('Belkin International Inc.');
      expect(host.script).to.not.exist; // No script output for this host
    });

    it('should parse host 192.168.130.71 correctly', () => {
      const host = result.hosts.find(h => h.ipv4Addr === '192.168.130.71');
      expect(host).to.exist;
      expect(host.mac).to.equal('20:6D:31:00:00:01');
      expect(host.macVendor).to.equal('FIREWALLA INC');
      expect(host.script).to.not.exist; // No script output for this host
    });

    it('should parse host 192.168.130.142 with vulnerability script correctly', () => {
      const host = result.hosts.find(h => h.ipv4Addr === '192.168.130.142');
      expect(host).to.exist;
      expect(host.mac).to.equal('5E:8D:D8:6C:F5:56');
      expect(host.macVendor).to.equal('Unknown');
      expect(host.script).to.exist;
      // Verify scriptId is correctly extracted and used as key
      expect(host.script['smb-vuln-ms17-010']).to.exist;
      expect(host.script['smb-vuln-ms17-010.nse']).to.not.exist; // Should not use full filename
      
      const scriptData = host.script['smb-vuln-ms17-010'];
      expect(scriptData.vulnerable).to.be.true;
      expect(scriptData.title).to.equal('Remote Code Execution vulnerability in Microsoft SMBv1 servers (ms17-010)');
      expect(scriptData.state).to.equal('VULNERABLE');
      expect(scriptData.disclosure).to.equal('2017-03-14');
      
      // Test with full path - should still extract correct scriptId
      const fullPathResult = Nmap.parseNmapTextOutput(realWorldOutput, '/path/to/scripts/smb-vuln-ms17-010.nse');
      const fullPathHost = fullPathResult.hosts.find(h => h.ipv4Addr === '192.168.130.142');
      expect(fullPathHost.script['smb-vuln-ms17-010']).to.exist;
      expect(fullPathHost.script['/path/to/scripts/smb-vuln-ms17-010.nse']).to.not.exist; // Should not use full path
    });

    it('should parse host 192.168.130.1 correctly', () => {
      const host = result.hosts.find(h => h.ipv4Addr === '192.168.130.1');
      expect(host).to.exist;
      expect(host.ipv4Addr).to.equal('192.168.130.1');
      expect(host.mac).to.be.null; // No MAC address for this host
      expect(host.script).to.not.exist; // No script output for this host
    });
  });

//   describe('Should parse multiple scripts output', () => {
//     const output = `Starting Nmap 7.94 ( https://nmap.org ) at 2025-11-18 17:30
// Nmap scan report for 192.168.130.142
// Host is up (0.0018s latency).
// Not shown: 995 filtered tcp ports (no-response)
// PORT     STATE SERVICE
// 53/tcp   open  domain
// 135/tcp  open  msrpc
// 139/tcp  open  netbios-ssn
// 445/tcp  open  microsoft-ds
// 5357/tcp open  wsdapi
// MAC Address: 5E:8D:D8:6C:F5:56 (Unknown)

// Host script results:
// | nbstat: NetBIOS name: WIN-44B993G3CIX, NetBIOS user: <unknown>, NetBIOS MAC: 5e:8d:d8:6c:f5:56 (unknown)
// | Names:
// |   WIN-44B993G3CIX<00>  Flags: <unique><active>
// |   WORKGROUP<00>        Flags: <group><active>
// |_  WIN-44B993G3CIX<20>  Flags: <unique><active>
// | smb-vuln-ms17-010:
// |   VULNERABLE:
// |   Remote Code Execution vulnerability in Microsoft SMBv1 servers (ms17-010)
// |     State: VULNERABLE
// |     IDs:  CVE:CVE-2017-0143
// |     Risk factor: HIGH
// |       A critical remote code execution vulnerability exists in Microsoft SMBv1
// |        servers (ms17-010).
// |
// |     Disclosure date: 2017-03-14
// |     References:
// |       https://technet.microsoft.com/en-us/library/security/ms17-010.aspx
// |       https://blogs.technet.microsoft.com/msrc/2017/05/12/customer-guidance-for-wannacrypt-attacks/
// |_      https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2017-0143

// Nmap done: 1 IP address (1 host up) scanned in 5.65 seconds`
//   })

});
