#!/bin/bash

# $1: filename
# $2: password
# $3: url
# $4: fullcontrol

/home/pi/firewalla/scripts/techsupport short 10
gpg --passphrase $2 --symmetric --cipher-algo AES256 /home/pi/tmp/support.tar.gz
mv /home/pi/tmp/support.tar.gz.gpg /home/pi/tmp/$1

if [ -z "$4" ]
   then 
       curl --upload /home/pi/tmp/$1 $3 
   else 
       curl --upload /home/pi/tmp/$1 -H 'x-amz-acl: bucket-owner-full-control' $3
fi
rm /home/pi/tmp/$1
