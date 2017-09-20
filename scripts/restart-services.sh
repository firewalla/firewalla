#!/bin/bash

SERVICES="firemain firemon firekick fireapi"
for service in $SERVICES; do
  sudo systemctl restart $service
  sleep 5 # to make the restart more smooth, less memory consumption
done
