#!/bin/bash

RESULT=$(curl -s -X POST --header 'Content-Type: application/json' --header 'Accept: application/json' -d '{ "monitor": false }' 'http://localhost:8834/v1/encipher/simple?command=cmd&item=vpn_port_forwarding_check');

if echo $RESULT | grep '"result":true' &>/dev/null; then
  echo "port forwarding is complete"
else
  echo "port forwarding is not complete"
fi
