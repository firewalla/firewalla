#!/bin/bash

moff() {
  curl -s -o /dev/null -w "%{http_code}" -X POST --header 'Content-Type: application/json' --header 'Accept: application/json' -d '{ "monitor": false }' 'http://localhost:8834/v1/encipher/simple?command=set&item=policy&target='$1  
  echo ""
}

mon() {
  curl -s -o /dev/null -w "%{http_code}" -X POST --header 'Content-Type: application/json' --header 'Accept: application/json' -d '{ "monitor": true }' 'http://localhost:8834/v1/encipher/simple?command=set&item=policy&target='$1  
  echo ""
}

mycat () {
  curl https://raw.githubusercontent.com/firewalla/firewalla/master/scripts/cat.js > /tmp/cat.js 2>/dev/null
  $FIREWALLA_HOME/bin/node /tmp/cat.js --device "$1"
}

mycatip () {
  curl https://raw.githubusercontent.com/firewalla/firewalla/master/scripts/cat.js > /tmp/cat.js 2>/dev/null
  $FIREWALLA_HOME/bin/node /tmp/cat.js --ip "$1"
}