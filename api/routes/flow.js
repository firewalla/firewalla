/*    Copyright 2016-2021 Firewalla Inc.
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

const express = require('express');
const router = express.Router();

const HostManager = require('../../net2/HostManager.js');
const hostManager = new HostManager()

const platform = require('../../platform/PlatformLoader.js').getPlatform();

router.get('/stats', (req, res, next) => {
  const target = req.param.target
  const jsonobj = { stats: {} }

  const requiredPromises = [
    hostManager.last60MinStatsForInit(jsonobj, target),
    hostManager.last30daysStatsForInit(jsonobj, target),
    hostManager.newLast24StatsForInit(jsonobj, target),
    hostManager.last12MonthsStatsForInit(jsonobj, target)
  ];
  const platformSpecificStats = platform.getStatsSpecs();
  jsonobj.stats = {};
  for (const statSettings of platformSpecificStats) {
    requiredPromises.push(hostManager.getStats(statSettings, target)
      .then(s => jsonobj.stats[statSettings.stat] = s)
    );
  }

  Promise.all(requiredPromises).then(() => {
    res.json(jsonobj);
  })
});

module.exports = router;
