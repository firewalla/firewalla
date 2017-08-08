## Setup Process
* Test Case: After setup, it should be able to successfully boot up
  - should be able to successfully login with ssh (ssh password might change randomly, setup pub/priv key to login without password)
  - The following processes should exist
     - FireApi
     - FireMain
     - FireKick
     - FireMon
     - redis-server
  - The following ports should open:
     - FireApi - 0:0:0:0:8833, 127.0.0.1:8834 (for development branch, 127.0.0.1:8834 => 0.0.0.0:8834)
     - redis-server - 127.0.0.1:6379     
  - Santity test should pass
     - bash /home/pi/firewalla/scripts/sanity_check
* Test Case: Should be able to bind app successfully
  - Assume Firewalla Device and Firewalla App connect to same network
  - After Firewalla Device boot up
    - A new device will be displayed on app main interface
    - Tap to bind
    - Scan QR code from log file

       ```bash
       grep 'Or Scan this' /home/pi/.forever/kickui.log  -A 30
       ```

    - App should successfuly bind to Device (show main interface for this new joined device)
* Test Case: Restore Factory Defaults should always work.
  - After Firewalla Device bound to App, App can use "Settings -> Reset to Factory Defaults" to restore to defaults
       - The binding between App and Device will be lost
       - Every new file created on device will be wiped out
       - Device will boot as a complete new device
* Test Case: **Hard** Restore Factory Defaults should always work. Device has another way to restore to factory defaults in case App can NOT be used for restoration
  - Prepare a USB thumb drive, with one linux partition (ext3/ext4/fat32)
  - Touch file 'firewalla_reset'under root folder
  - Plugin the USB thumb drive to Firewalla Device, reboot device
  - Device should be able to successfully recognize the file on the USB thumb drive, and restore device to factory defaults successfully.
      - The binding between App and Device will be lost
      - Every new file created on device will be wiped out
      - Device will boot as a complete new device
* Test Case: Reboot device should work
  - After rebooting device, App should still be able to connect to device and load data
* Test Case: Unplug ethernet cable, device should reboot
  - As a protection (in case device brings the entire network down), device will automatically reboot in 10 seconds if network gateway is not reachable any more
* Test Case: If ethernet cable is NOT plugged in, firewalla processes should NEVER start up
  - Firewalla Processes: FireApi, FireMain, FireKick, FireMon
  - After plug in the ethernet cable, these processes should start automatically in 60 seconds
  - BTW: This test case can't be easily tested without debug serial cable
* Test Case: Unplug and plug in ethernet cable immediately, device should continue working as usual
* Test Case: Unplug and plug in power cable (micro-usb), device should reboot and work as usual after boot up
## Device
### Device Mode
  - normal (monitoring turned on)
  - internet off (not able to access internet)
  - monitoring off (do not monitor this device)
  - AD Block on (filtering AD websites)
  - Family Mode (filtering porn websites)
### Test Cases
* Test Case: User device should NOT be able to access internet when "internet off" feature is turned on
* Test Case: User device should continue be able to access other devices in the network when "internet off" feature is turned on
* Test Case: User device should NOT be able to access doubleclick.net when adblock is on
* Test Case: Change Device Name should work
## Data Flow
* Test Case: Should be able to view the last 24 hours data flow in main UI
* Test Case: Tap on the data flow will show the breakdown info by hour
  - History => Recent data flows
  - Download => Top Downloads
  - Upload => Top Uploads
  - Apps => Top Apps
## Spoofing
* Test Case: Spoofing new device should work
  - When a new device joined the network, firewalla should automatically arp spoofing this device
    - 'redis-cli smembers monitored_hosts' @ Firewalla should contain this new device's IP address
    -  'arp -a -n' @ user device side should show that gateway IP is bound to Firewalla's MAC address
* Test Case: When device is configured "not monitoring" @ App, spoofing should stop automatically
  - When select NOT to monitor device on Firewalla App, firewalla should automatically stop the arp spoofing
    - 'redis-cli smembers monitored_hosts' should NOT contain this device's IP address
    - 'redis-cli smembers unmonitored_hosts' should contain this device's IP address
    -  'arp -a -n' @ the user device side should show that gateway IP is bound to the real gateway MAC address
* Test Case: Turn off and on iPhone Wifi, spoofing should continue work
  - assume iphone and Firewalla should join same network
## Alarm
* Test Case: New device alarm should be generated when a new device joins the network
