
## Firewalla
* Support https://help.firewalla.com (email help@firewalla.com)
* Stable Branch: release_6_0 
* Beta Branch: beta_6_0
* Alpha Branch: beta_7_0
* SuperAlpha Branch: beta_8_0
* Unstable Branch: master

## Software Image
### Firewalla Blue
* https://github.com/firewalla/firewalla/releases/download/v1.963/firewalla.blue.stable.0.28.img.gz
  * sha256sum: 98e7110c26a9ff4b14eb2edb43aeffbcd1c058baef801d53799d64912202204b
* Flash image to micro sd card, and put into Firewalla Blue
  * Guide: https://help.firewalla.com/hc/en-us/articles/115004796633-Tutorial-Flashing-Image
* You can order Firewalla Blue at https://firewalla.com
### Firewalla Red
* https://github.com/firewalla/firewalla/releases/download/v1.958/fos.release_6_16.armv7l.img.gz
  * sha256sum: 7425195a1b04ff5fbe11910dc8cd31ceb8af0364e7cf0e5813dadc7ef8063273
* Flash image to micro sd card, and put into Firewalla Red
  * Guide: https://help.firewalla.com/hc/en-us/articles/115004796633-Tutorial-Flashing-Image
* You can order Firewalla Red at https://firewalla.com
### Firewalla Gold
* You can pre-order Firewalla Gold at Indiegogo Crowdfunding
  * https://igg.me/at/firewallagold/x#/
### Raspberry Pi (Strongly Not Recommended, this image is out-of-date)
```
If you have Raspberry Pi 3 and want a preview.  The preview image is a over two years old.  
Download https://github.com/firewalla/firewalla/releases/download/1.6/firewalla1.6a.img.gz
Prepare a blank microsd card > 8GB size
Follow the same step as installing a raspberry pi image
https://www.raspberrypi.org/documentation/installation/installing-images/
```
We are focusing on delivering the official hardware, hence Raspberry Pi support is a bit lacking, we are hoping to pick it up soon.  We will be very likely selling a development version of Firewalla very soon.  It will be at cost with a small mark up to take care the labor involved. 

## Build By Yourself
### To Build On Raspberry Pi
- Download Jessie Lite
```
https://www.raspberrypi.org/downloads/raspbian/
follow direction to flash this to a card
```
- Boot Pi and update
```
sudo apt-get update
sudo apt-get -y dist-upgrade
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
## Apps
### iOS App
* App Store (Stable): https://itunes.apple.com/us/app/firewalla/id1180904053
* TestFlight (Beta App): https://testflight.apple.com/join/qtUnSjJp

### Android App
* Google Play (Stable): https://play.google.com/store/apps/details?id=com.firewalla.chancellor&hl=en_US
* Beta App: https://play.google.com/apps/testing/com.firewalla.chancellor

## Firewalla Box Install Guide
https://firewalla.com/install

If anything bad happens, unplug it. :)  The raspberry pi version uses bluetooth to link the app with the board. Final hardware will require a scan of a barcode.

## Contributions

* origin/master:  latest / greatest
* release_pi_1:   current released code for pi, will be pulled automatically by all deployed boards.
* dev_<>: development branchs.
* Please do a pull request for features

## Router Compatibility

* For router compatibility, please check out detail information at https://help.firewalla.com/hc/en-us/articles/360009401874-Router-Compatibility



