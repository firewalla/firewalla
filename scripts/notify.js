/*    Copyright 2016 Firewalla LLC / Firewalla LLC
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

const AlarmManager2 = require('../alarm/AlarmManager2.js')
const am2 = new AlarmManager2()

const program = require('commander');

const async = require('asyncawait/async');
const await = require('asyncawait/await');

program.version('0.0.2')
  .option('--alarm [alarm]', 'alarm id to resend notification');

program.parse(process.argv);

if(program.alarm) {
  let alarmID = program.alarm
  
  async(() => {
    await (am2.notifAlarm(alarmID))
    process.exit(0)
  })()
}
