/*    Copyright 2016-2019 Firewalla INC
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

var VpnManager = require('./VpnManager.js');
vpnManager = new VpnManager('info');

setTimeout(() => {
    vpnManager.install("server", (err) => {
        if (err != null) {
            console.log("VpnManager:Unable to start vpn");
        } else {
            vpnManager.configure({
                serverNetwork: "10.8.0.0",
                localPort: "1194"
            }, true, (err) => {
                if (err != null) {
                    console.log("VpnManager: Unable to configure vpn");
                } else {
                    vpnManager.start((err) => {
                        vpnManager.getOvpnFile("fishbowVPN", null, false, (err, ovpnfile, password) => {
                            console.log(err, ovpnfile, password);
                        });
                    });
                }
            });
        }
    });
}, 0000);