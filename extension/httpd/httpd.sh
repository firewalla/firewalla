#!/usr/bin/env bash

DIR="$( cd "$( dirname "$0" )" && pwd )"

export NODE_PATH=/home/pi/.node_modules:$NODE_PATH
/home/pi/firewalla/bin/node $DIR/app.js