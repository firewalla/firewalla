#!/bin/bash

/usr/bin/which wg || sudo apt install wireguard-tools --no-install-recommends
# conntrack is used to check wireguard port forward
/usr/bin/which conntrack || sudo apt install -y conntrack