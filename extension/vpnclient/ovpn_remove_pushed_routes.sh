#!/bin/bash

# remove routes pushed from OpenVPN server due to redirect-gateway options
sudo ip route del 0.0.0.0/1
sudo ip route del 128.0.0.0/1