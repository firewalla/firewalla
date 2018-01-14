#!/bin/bash

function setup_folders() {
    mkdir -p ~/.dns
    mkdir -p ~/.firewalla/config
    mkdir -p ~/.firewalla/run
    mkdir -p ~/.forever
    mkdir -p ~/logs
    cd ~/.firewalla/; ln -s ~/.forever log; cd -
}
