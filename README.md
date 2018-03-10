[![Build Status](https://travis-ci.org/firewalla/firewalla.svg?branch=master)](https://travis-ci.org/firewalla/firewalla)
<a href="https://scan.coverity.com/projects/firewalla-firewalla">
  <img alt="Coverity Scan Build Status"
       src="https://scan.coverity.com/projects/11583/badge.svg"/>
</a>
## Firewalla  (Beta)
Support https://help.firewalla.com (email help@firewalla.com)

Current Stable Branch: release_6_0 
Current Beta Branch: beta_6_0

## Install From Image
```
If you have Raspberry Pi 3 and want a preview.  The preview image is a over 6 months old.  
Download https://github.com/firewalla/firewalla/releases/download/1.6/firewalla1.6a.img.gz
Prepare a blank microsd card > 8GB size
Follow the same step as installing a raspberry pi image
https://www.raspberrypi.org/documentation/installation/installing-images/


```
We are focusing on delivering the official hardware, hence Raspberry Pi support is a bit lacking, we are hoping to pick it up soon.  We will be very likely selling a development version of Firewalla very soon.  It will be at cost with a small mark up to take care the labor involved. 

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

### Build On Docker (Beta, for development purpose only)
```
cd docker
docker build -f Dockerfile2 -t firewalla .
docker run --privileged -p 8833:8833 -p 8834:8834 -ti firewalla
# to get an interactive shell
docker run --privileged -p 8833:8833 -p 8834:8834 -ti firewalla su - pi
```

### Get iPhone Software

Encipher Connect is a secure messenger used to talk to Raspberry Pi.

```
https://itunes.apple.com/us/app/firewalla/id1180904053

```

* connect ethernet port to router.
* install firewalla from app store.
* launch firewalla 
* tap on 'Firewalla' and connect

If anything bad happens, unplug it. :)  The raspberry pi version uses bluetooth to link the app with the board. Final hardware will require a scan of a barcode.

### Contributions

* origin/master:  latest / greatest
* release_pi_1:   current released code for pi, will be pulled automatically by all deployed boards.
* dev_<>: development branchs.
* Please do a pull request for features


### Following Routers are NOT supported in simple mode.

#### ACTIONTEC
* T3200M 

#### ASUS
* N600 RT-N56U (NAT Acceleration must be turned off)

#### GOOGLE
* OnHub TGR-1900 (TP-Link)
* OnHub SRT-AC1900 (ASUS)

#### LINKSYS
* N600 EA2500 (Not support guest network)
* AC1900 EA7500 (Express Forwarding must be disabled)
* AC2400 EA8350
* AC2600 Max-Stream EA8500 (Express Forwarding must be disabled)

#### NETGEAR
* N600 WNDR3400 (Not compatible with guest network)
* AC1600 R6250
* AC1750 R6400 
* AC2350 Nighthawk X4 R7500
* AC2600 Nighthawk X4S R7800 


### DHCP Mode
DHCP mode should work with most of the routers out there.  Except google.* router. 




