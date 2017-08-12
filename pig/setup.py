#!/usr/bin/python

# setup.py Authors:
#   Philippe Thierry <phil@reseau-libre.net>

import os
import os.path

from distutils.core import setup

setup(
    name="dhcpig",
    author="Kevin Amorin",
    description="DHCP exhaustion script using scapy network library",
    license="GPL2+",
    url="https://github.com/kamorin/DHCPig",
    scripts=[
        ("pig.py")
    ],
)
