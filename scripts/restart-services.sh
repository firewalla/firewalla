#!/bin/bash

SERVICES="firemain firemon firekick fireapi"
for service in $SERVICES; do
  sudo systemctl restart $service
done
