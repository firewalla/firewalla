#!/bin/bash

# $1: filename
# $2: password
# $3: url

url=${3-'https://firewallasupportupload.s3-us-west-2.amazonaws.com'}

/home/pi/firewalla/scripts/techsupport
gpg --passphrase $2 --symmetric --cipher-algo AES256 /home/pi/tmp/support.tar.gz
mv /home/pi/tmp/support.tar.gz.gpg /home/pi/tmp/$1
curl --upload /home/pi/tmp/$1 $url
rm /home/pi/tmp/$1
