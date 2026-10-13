/*    Copyright 2026 Firewalla Inc.
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

const chai = require('chai');
const expect = chai.expect;
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const proxyquire = require('proxyquire').noCallThru();

// Helper: assert async function throws with message containing substr
async function expectThrows(fn, substr) {
  let threw = false;
  try {
    await fn();
  } catch (e) {
    threw = true;
    if (substr) expect(e.message).to.include(substr);
  }
  expect(threw, `Expected rejection containing "${substr}", but resolved`).to.be.true;
}

// Helper: file octal permissions
function fileMode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

describe('SSH saveRSAPublicKey / saveRSAPrivateKey', function () {
  this.timeout(10000);

  let SSH, ssh, tmpHome, sshDir, authKeysPath;

  beforeEach(() => {
    // fresh temp home dir per test
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-ssh-test-'));
    sshDir = path.join(tmpHome, '.ssh');
    fs.mkdirSync(sshDir, { mode: 0o700 });
    authKeysPath = path.join(sshDir, 'authorized_keys');
    fs.writeFileSync(authKeysPath, '', { mode: 0o644 });

    // proxyquire loads a fresh module (bypasses singleton cache)
    SSH = proxyquire('../extension/ssh/ssh.js', {
      '../../net2/Firewalla.js': {
        getUserHome: () => tmpHome,
        isApi: () => false,
      },
      '../../net2/logger.js': () => ({
        info: () => {}, error: () => {}, warn: () => {}, debug: () => {},
      }),
      '../../platform/PlatformLoader.js': {
        getPlatform: () => ({ getSSHPasswdFilePath: () => path.join(tmpHome, '.ssh_passwd') }),
      },
      '../common/key.js': {},
    });
    ssh = new SSH();
  });

  afterEach(() => {
    try { execSync(`rm -rf ${tmpHome}`); } catch (_) {}
  });

  // ─── saveRSAPublicKey ───────────────────────────────────────────────────────

  describe('saveRSAPublicKey', () => {
    it('writes content to <identity>.pub', async () => {
      const content = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABtest123 user@host';
      await ssh.saveRSAPublicKey(content, 'mykey');

      const written = fs.readFileSync(path.join(sshDir, 'mykey.pub'), 'utf8');
      expect(written).to.equal(content);
    });

    it('appends content to authorized_keys', async () => {
      const content = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABtest123 user@host';
      await ssh.saveRSAPublicKey(content, 'mykey');

      const authKeys = fs.readFileSync(authKeysPath, 'utf8');
      expect(authKeys).to.include(content);
    });

    it('sets pub key file mode to 0600', async () => {
      await ssh.saveRSAPublicKey('ssh-rsa test', 'mykey');
      expect(fileMode(path.join(sshDir, 'mykey.pub'))).to.equal(0o600);
    });

    it('sets authorized_keys file mode to 0644', async () => {
      await ssh.saveRSAPublicKey('ssh-rsa test', 'mykey');
      expect(fileMode(authKeysPath)).to.equal(0o644);
    });

    it('uses id_rsa_firewalla as default identity', async () => {
      await ssh.saveRSAPublicKey('ssh-rsa test');
      expect(fs.existsSync(path.join(sshDir, 'id_rsa_firewalla.pub'))).to.be.true;
    });

    it('allows alphanumeric + underscore identities', async () => {
      await ssh.saveRSAPublicKey('ssh-rsa test', 'my_key_123');
      expect(fs.existsSync(path.join(sshDir, 'my_key_123.pub'))).to.be.true;
    });

    it('allows hyphen in identity', async () => {
      await ssh.saveRSAPublicKey('ssh-rsa test', 'my-key-123');
      expect(fs.existsSync(path.join(sshDir, 'my-key-123.pub'))).to.be.true;
    });

    it('rejects identity with shell metachar (single quote)', async () => {
      await expectThrows(
        () => ssh.saveRSAPublicKey('ssh-rsa test', "evil'; touch /tmp/pwned; #"),
        'Invalid SSH identity name'
      );
    });

    it('rejects identity with path traversal (../)', async () => {
      await expectThrows(
        () => ssh.saveRSAPublicKey('ssh-rsa test', '../etc/passwd'),
        'Invalid SSH identity name'
      );
    });

    it('rejects identity with spaces', async () => {
      await expectThrows(
        () => ssh.saveRSAPublicKey('ssh-rsa test', 'my key'),
        'Invalid SSH identity name'
      );
    });

    it('rejects identity with semicolon', async () => {
      await expectThrows(
        () => ssh.saveRSAPublicKey('ssh-rsa test', 'a;b'),
        'Invalid SSH identity name'
      );
    });

    it('does not create pub key file when identity is invalid', async () => {
      try {
        await ssh.saveRSAPublicKey('ssh-rsa test', "evil'; rm -rf /; #");
      } catch (_) {}
      const files = fs.readdirSync(sshDir);
      expect(files.filter(f => f.endsWith('.pub') && f !== 'authorized_keys')).to.have.length(0);
    });
  });

  // ─── saveRSAPrivateKey ──────────────────────────────────────────────────────

  describe('saveRSAPrivateKey', () => {
    it('writes content to <identity>', async () => {
      const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKtest\n-----END RSA PRIVATE KEY-----';
      await ssh.saveRSAPrivateKey(content, 'mykey');

      const written = fs.readFileSync(path.join(sshDir, 'mykey'), 'utf8');
      expect(written).to.equal(content);
    });

    it('sets private key file mode to 0600', async () => {
      await ssh.saveRSAPrivateKey('-----BEGIN RSA PRIVATE KEY-----', 'mykey');
      expect(fileMode(path.join(sshDir, 'mykey'))).to.equal(0o600);
    });

    it('uses id_rsa_firewalla as default identity', async () => {
      await ssh.saveRSAPrivateKey('-----BEGIN RSA PRIVATE KEY-----');
      expect(fs.existsSync(path.join(sshDir, 'id_rsa_firewalla'))).to.be.true;
    });

    it('allows alphanumeric + underscore identities', async () => {
      await ssh.saveRSAPrivateKey('key content', 'my_key_123');
      expect(fs.existsSync(path.join(sshDir, 'my_key_123'))).to.be.true;
    });

    it('allows hyphen in identity', async () => {
      await ssh.saveRSAPrivateKey('key content', 'my-key-123');
      expect(fs.existsSync(path.join(sshDir, 'my-key-123'))).to.be.true;
    });

    it('rejects identity with shell metachar (single quote)', async () => {
      await expectThrows(
        () => ssh.saveRSAPrivateKey('key content', "evil'; rm -rf /; #"),
        'Invalid SSH identity name'
      );
    });

    it('rejects identity with path traversal (../../)', async () => {
      await expectThrows(
        () => ssh.saveRSAPrivateKey('key content', '../../etc/shadow'),
        'Invalid SSH identity name'
      );
    });

    it('rejects identity with dollar sign (command substitution)', async () => {
      await expectThrows(
        () => ssh.saveRSAPrivateKey('key content', '$(whoami)'),
        'Invalid SSH identity name'
      );
    });

    it('does not create key file when identity is invalid', async () => {
      try {
        await ssh.saveRSAPrivateKey('key content', "evil'; rm -rf /; #");
      } catch (_) {}
      const files = fs.readdirSync(sshDir);
      // only authorized_keys should exist, no private key file
      const keyFiles = files.filter(f => f !== 'authorized_keys');
      expect(keyFiles).to.have.length(0);
    });
  });

  // ─── Helper: SSH instance with mocked execFile ──────────────────────────────

  function sshWithCapturedExecFile(captures) {
    const MockSSH = proxyquire('../extension/ssh/ssh.js', {
      '../../net2/Firewalla.js': { getUserHome: () => tmpHome, isApi: () => false },
      '../../net2/logger.js': () => ({ info() {}, error() {}, warn() {}, debug() {} }),
      '../../platform/PlatformLoader.js': {
        getPlatform: () => ({ getSSHPasswdFilePath: () => path.join(tmpHome, '.ssh_passwd') }),
      },
      '../common/key.js': {},
      'child_process': {
        exec: require('child_process').exec,
        execFile: (file, args, opts, cb) => {
          if (typeof opts === 'function') { cb = opts; }
          captures.push({ file, args });
          cb(null, '', '');
        },
      },
    });
    return new MockSSH();
  }

  // ─── generateRSAKeyPair ──────────────────────────────────────────────────────

  describe('generateRSAKeyPair', () => {
    it('rejects identity with shell metachar', async () => {
      await expectThrows(
        () => ssh.generateRSAKeyPair("evil'; touch /tmp/pwned; #"),
        'Invalid SSH identity name'
      );
    });

    it('rejects identity with path traversal', async () => {
      await expectThrows(
        () => ssh.generateRSAKeyPair('../evil'),
        'Invalid SSH identity name'
      );
    });

    it('generates private and public key files', async () => {
      await ssh.generateRSAKeyPair('gen-test');
      expect(fs.existsSync(path.join(sshDir, 'gen-test'))).to.be.true;
      expect(fs.existsSync(path.join(sshDir, 'gen-test.pub'))).to.be.true;
    });

    it('generated public key starts with ssh-rsa', async () => {
      await ssh.generateRSAKeyPair('gen-test');
      const pub = fs.readFileSync(path.join(sshDir, 'gen-test.pub'), 'utf8');
      expect(pub.trim()).to.match(/^ssh-rsa /);
    });

    it('uses default identity id_rsa_firewalla', async () => {
      await ssh.generateRSAKeyPair();
      expect(fs.existsSync(path.join(sshDir, 'id_rsa_firewalla'))).to.be.true;
      expect(fs.existsSync(path.join(sshDir, 'id_rsa_firewalla.pub'))).to.be.true;
    });

    it('overwrites existing key pair without error', async () => {
      fs.writeFileSync(path.join(sshDir, 'gen-test'), 'old-private');
      fs.writeFileSync(path.join(sshDir, 'gen-test.pub'), 'old-public');
      await ssh.generateRSAKeyPair('gen-test');
      const pub = fs.readFileSync(path.join(sshDir, 'gen-test.pub'), 'utf8');
      expect(pub).to.not.equal('old-public');
      expect(pub.trim()).to.match(/^ssh-rsa /);
    });
  });

  // ─── getRSAPublicKey ─────────────────────────────────────────────────────────

  describe('getRSAPublicKey', () => {
    it('returns null when key does not exist', async () => {
      expect(await ssh.getRSAPublicKey('no-such-key')).to.be.null;
    });

    it('returns key content when key exists', async () => {
      const content = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABtest user@host\n';
      fs.writeFileSync(path.join(sshDir, 'mykey.pub'), content);
      expect(await ssh.getRSAPublicKey('mykey')).to.equal(content);
    });

    it('uses default identity id_rsa_firewalla', async () => {
      fs.writeFileSync(path.join(sshDir, 'id_rsa_firewalla.pub'), 'ssh-rsa default');
      expect(await ssh.getRSAPublicKey()).to.equal('ssh-rsa default');
    });

    it('rejects invalid identity', async () => {
      await expectThrows(
        () => ssh.getRSAPublicKey('../etc/passwd'),
        'Invalid SSH identity name'
      );
    });
  });

  // ─── getRSAPEMPublicKey ──────────────────────────────────────────────────────

  describe('getRSAPEMPublicKey', () => {
    it('returns null when key does not exist', async () => {
      expect(await ssh.getRSAPEMPublicKey('no-such-key')).to.be.null;
    });

    it('rejects invalid identity', async () => {
      await expectThrows(
        () => ssh.getRSAPEMPublicKey("bad'id"),
        'Invalid SSH identity name'
      );
    });

    it('converts existing RSA public key to PKCS8 PEM', async () => {
      await ssh.generateRSAKeyPair('pem-test');
      const pem = await ssh.getRSAPEMPublicKey('pem-test');
      expect(pem).to.be.a('string');
      expect(pem).to.include('BEGIN PUBLIC KEY');
    });
  });

  // ─── getRSAPEMPrivateKey ─────────────────────────────────────────────────────

  describe('getRSAPEMPrivateKey', () => {
    it('returns null when key does not exist', async () => {
      expect(await ssh.getRSAPEMPrivateKey('no-such-key')).to.be.null;
    });

    it('returns key content when key exists', async () => {
      const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEtest\n-----END RSA PRIVATE KEY-----';
      fs.writeFileSync(path.join(sshDir, 'mykey'), content);
      const result = await ssh.getRSAPEMPrivateKey('mykey');
      expect(result.toString()).to.equal(content);
    });

    it('uses default identity id_rsa_firewalla', async () => {
      const content = '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----';
      fs.writeFileSync(path.join(sshDir, 'id_rsa_firewalla'), content);
      expect((await ssh.getRSAPEMPrivateKey()).toString()).to.equal(content);
    });

    it('rejects invalid identity', async () => {
      await expectThrows(
        () => ssh.getRSAPEMPrivateKey('../../etc/shadow'),
        'Invalid SSH identity name'
      );
    });
  });

  // ─── remoteCommand ───────────────────────────────────────────────────────────

  describe('remoteCommand', () => {
    let captures, sshMocked;

    beforeEach(() => {
      captures = [];
      sshMocked = sshWithCapturedExecFile(captures);
    });

    it('rejects invalid identity', async () => {
      await expectThrows(
        () => ssh.remoteCommand('192.168.1.1', 'ls', 'pi', "evil'; rm -rf /; #"),
        'Invalid SSH identity name'
      );
    });

    it('calls ssh with correct argv', async () => {
      await sshMocked.remoteCommand('192.168.1.1', 'ls -la', 'pi', 'my-key');
      expect(captures).to.have.length(1);
      const { file, args } = captures[0];
      expect(file).to.equal('ssh');
      expect(args).to.include(`${tmpHome}/.ssh/my-key`);
      expect(args).to.include('pi@192.168.1.1');
      expect(args).to.include('ls -la');
    });

    it('passes StrictHostKeyChecking=no', async () => {
      await sshMocked.remoteCommand('192.168.1.1', 'ls', 'pi', 'my-key');
      expect(captures[0].args).to.include('StrictHostKeyChecking=no');
    });

    it('uses default identity id_rsa_firewalla', async () => {
      await sshMocked.remoteCommand('192.168.1.1', 'ls', 'pi');
      expect(captures[0].args).to.include(`${tmpHome}/.ssh/id_rsa_firewalla`);
    });
  });

  // ─── scpFile ─────────────────────────────────────────────────────────────────

  describe('scpFile', () => {
    let captures, sshMocked;

    beforeEach(() => {
      captures = [];
      sshMocked = sshWithCapturedExecFile(captures);
    });

    it('rejects invalid identity', async () => {
      await expectThrows(
        () => ssh.scpFile('192.168.1.1', '/src', '/dst', false, '../evil'),
        'Invalid SSH identity name'
      );
    });

    it('calls scp with correct argv', async () => {
      await sshMocked.scpFile('192.168.1.1', '/tmp/src', '/tmp/dst', false, 'my-key', 'pi');
      expect(captures).to.have.length(1);
      const { file, args } = captures[0];
      expect(file).to.equal('scp');
      expect(args).to.include(`${tmpHome}/.ssh/my-key`);
      expect(args).to.include('/tmp/src');
      expect(args).to.include('pi@192.168.1.1:/tmp/dst');
    });

    it('adds -r flag when recursive is true', async () => {
      await sshMocked.scpFile('192.168.1.1', '/tmp/src', '/tmp/dst', true, 'my-key', 'pi');
      expect(captures[0].args).to.include('-r');
    });

    it('does not add -r flag when recursive is false', async () => {
      await sshMocked.scpFile('192.168.1.1', '/tmp/src', '/tmp/dst', false, 'my-key', 'pi');
      expect(captures[0].args).to.not.include('-r');
    });

    it('uses default identity id_rsa_firewalla', async () => {
      await sshMocked.scpFile('192.168.1.1', '/tmp/src', '/tmp/dst', false, undefined, 'pi');
      expect(captures[0].args).to.include(`${tmpHome}/.ssh/id_rsa_firewalla`);
    });

    it('passes StrictHostKeyChecking=no', async () => {
      await sshMocked.scpFile('192.168.1.1', '/tmp/src', '/tmp/dst', false, 'my-key', 'pi');
      expect(captures[0].args).to.include('StrictHostKeyChecking=no');
    });
  });
});
