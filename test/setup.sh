#!/bin/bash

mkdir -p ~/.node_modules.test/node_modules
cd ~/firewalla
rm node_modules
ln -sf ~/.node_modules.test/node_modules node_modules
nvm use v12
npm install
