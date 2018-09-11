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
            }, (err) => {
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