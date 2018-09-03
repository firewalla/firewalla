var VpnManager = require('./VpnManager.js');
vpnManager = new VpnManager('info');

setTimeout(() => {
    vpnManager.install((err) => {
        if (err != null) {
            console.log("VpnManager:Unable to start vpn");
        } else {
            vpnManager.start((err) => {
                vpnManager.getOvpnFile("fishbowVPN", null, null, null, false, (err, ovpnfile, password) => {
                    console.log(err, ovpnfile, password);
                });
            });
        }
    });
}, 0000);