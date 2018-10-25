#!/bin/bash

sudo iptables -w -F
sudo iptables -w -F -t nat
sudo ip6tables -w -F
sudo ip6tables -w -F -t nat
