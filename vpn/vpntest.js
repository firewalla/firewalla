var VpnManager = require('./VpnManager.js');
var vpnManager = new VpnManager('info');

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
}, 1);