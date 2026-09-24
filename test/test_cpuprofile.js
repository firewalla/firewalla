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
const fs = require('fs');
const path = require('path');

const cpuProfile = require('../net2/CpuProfile.js');
const Constants = require('../net2/Constants.js');

// applyProfile(name) puts name in the platform:profile:active redis key, which apply_profile.sh
// turns into a path, and uses it as a path component of the profile file it writes. Both happen
// after the guard, so every rejection below has to come from the guard and not from a later
// failure - that is why the tests assert on the exact message rather than just "it threw".
describe('CpuProfile.applyProfile name validation', function() {

  const rejected = [
    '../../../../home/pi/.firewalla/config/crontab/evil',
    '../profile_default',
    '/etc/passwd',
    'sub/dir',
    'profile default',
    'x;id',
    'x id',
    '$(id)',
    '`id`',
    'x\nid',
    '.',
    '..',
    '.hidden',
    '-rf',
    '',
  ];

  for (const name of rejected) {
    it(`rejects ${JSON.stringify(name)}`, async function() {
      let err = null;
      try {
        await cpuProfile.applyProfile(name);
      } catch (e) {
        err = e;
      }
      expect(err, 'should have thrown').to.be.an('error');
      expect(err.message).to.equal(`Invalid profile name: ${name}`);
    });
  }

  for (const name of [null, undefined, 42, true, {}, ['profile_default']]) {
    it(`rejects the non-string ${JSON.stringify(name) || String(name)}`, async function() {
      let err = null;
      try {
        await cpuProfile.applyProfile(name);
      } catch (e) {
        err = e;
      }
      expect(err, 'should have thrown').to.be.an('error');
      expect(err.message).to.match(/^Invalid profile name: /);
    });
  }
});

// the guard is only useful if it still accepts what ships in the repo
describe('Constants.REGEX_FILENAME', function() {

  it('accepts every profile name shipped under platform/*/profile', function() {
    const platformDir = path.join(__dirname, '..', 'platform');
    const names = [];
    for (const p of fs.readdirSync(platformDir)) {
      const dir = path.join(platformDir, p, 'profile');
      if (!fs.existsSync(dir)) continue;
      for (const n of fs.readdirSync(dir)) names.push(`${p}/${n}`);
    }
    expect(names, 'no shipped profiles found, the test would be vacuous').to.not.be.empty;
    for (const n of names) {
      const name = n.split('/')[1];
      expect(Constants.REGEX_FILENAME.test(name), `${n} must be accepted`).to.be.true;
    }
  });

  it('accepts the script names the cloud script control needs to reach', function() {
    for (const n of ['upgrade', 'fire-reboot-normal', 'apt-get.sh', 'diag.sh', 'firelog'])
      expect(Constants.REGEX_FILENAME.test(n), n).to.be.true;
  });

  it('rejects anything that could leave the directory it is resolved against', function() {
    for (const n of ['../x', '..', '.', 'a/b', '/abs', './x', 'x/', '-flag', '', ' x', 'x ', 'a b'])
      expect(Constants.REGEX_FILENAME.test(n), n).to.be.false;
  });

  it('rejects shell and command substitution metacharacters', function() {
    for (const n of ['x;id', 'x|id', 'x&id', '$(id)', '`id`', 'x\nid', 'x>y', 'x*'])
      expect(Constants.REGEX_FILENAME.test(n), n).to.be.false;
  });

  it('has no global flag, so test() carries no lastIndex state between call sites', function() {
    // netbot.js and CpuProfile.js share this one regex object
    expect(Constants.REGEX_FILENAME.global).to.be.false;
    expect(Constants.REGEX_FILENAME.sticky).to.be.false;
  });
});
