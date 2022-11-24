#!/bin/bash

sudo sed -i "s/^auto eth0/allow-hotplug eth0/" /etc/network/interfaces.d/eth0 
