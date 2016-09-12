
## Firewalla  (Pre-Alpha)
### To Build On Raspberry Pi
- Download Jessie Lite
```
https://www.raspberrypi.org/downloads/raspbian/
follow direction to flash this to a card
```
- Boot Pi and update
```
sudo apt-get update
sudo apt-get -y  dist-upgrade
sudo apt-get -y install git

```
- Configure Pi
```
- sudo raspi-config
- Change Password
- Host Name
- Advance Options -> Memory Split (Change to 16)
- Expand File System
- Reboot
```

- Install On Device
```
git clone https://github.com/firewalla/firewalla --branch release_pi_1_0 --single-branch
cd firewalla
./buildraw
sudo apt-get clean


** for development please create your own branch. (release_pi_1_0 is for official releases)

```


### Get IPhone Software

Encipher Connect is a secure messenger used to talk to Raspberry Pi.

```
https://itunes.apple.com/us/app/encipher-connect/id1082886344?mt=8
```

* connect ethernet port to router.
* install encipher connect from app store.
* launch encipher connect
* tap on 'fishbowl' and connect

If anything bad happens, unplug it. 

### Contributions

* origin/master:  latest / greatest
* release_pi_1:   current released code for pi, will be pulled automatically by all deployed boards.
* dev_<>: development branchs.
* Please do a pull request for features



