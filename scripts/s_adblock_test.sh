#!/bin/bash

function test_domain {
  DOMAIN=$1
  RESULT=$(dig -p 8853 @localhost $DOMAIN +short +time=10)

  if [[ $RESULT == "198.51.100.99" || $RESULT == "0.0.0.0" ]]; then
    return 0
  else
    echo "adblock is off, $DOMAIN is resolved to ${RESULT}"
    FAMILY=$(redis-cli hget policy:system family)
    if [[ "x$FAMILY" == "xtrue" ]]; then
      echo "family mode is on, family dns result for $DOMAIN is: $(dig @$(head -n 1 /home/pi/.firewalla/run/dnsmasq.resolv.conf | sed 's=nameserver ==') $DOMAIN +short +time=10)"
    fi
    echo "local dns returns result: $(dig $DOMAIN +short +time=10)"
    return 1
  fi
}

test_domain "doubleclick.com" && test_domain "doubleclick.net" && test_domain "onclickads.net" && echo "adblock is on"
