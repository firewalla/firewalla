#!/bin/bash

# $1: filename
# $2: password
# $3: url
# $4: fullcontrol

/home/pi/firewalla/scripts/techsupport short 10
GPG_VERSION=$(gpg --version | head -n 1 | awk '{print $3}' | awk -F. '{print $1}')

if [[ $GPG_VERSION == "1" ]]; then
  gpg --passphrase $2 --symmetric --cipher-algo AES256 /home/pi/tmp/support.tar.gz
else
  echo $2 | gpg --batch --yes --passphrase-fd 0 --symmetric --cipher-algo AES256 /home/pi/tmp/support.tar.gz
fi

mv /home/pi/tmp/support.tar.gz.gpg /home/pi/tmp/$1

if [ -z "$4" ]
   then 
       curl --upload /home/pi/tmp/$1 $3 
   else 
       curl --upload /home/pi/tmp/$1 -H 'x-amz-acl: bucket-owner-full-control' $3
fi
rm /home/pi/tmp/$1
