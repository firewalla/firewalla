#!/bin/bash

RESULT=$(dig +short +time=10 -p 8853 @localhost welcome.opendns.com | tail -n 1)

if [[ $RESULT == "146.112.59.8" ]]; then
  echo "family mode is on. welcome.opendns.com is $RESULT";
  exit 0
else
  echo "family mode is off. welcome.opendns.com is $RESULT";
  exit 1
fi
