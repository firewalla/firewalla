#!/bin/bash

# Re-apply CPUQuota after deploy so steady-state brofish stays limited
sudo systemctl set-property brofish.service CPUQuota=25%
