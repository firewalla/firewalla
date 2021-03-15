#!/bin/bash

sudo -u redis redis-cli config set maxmemory ${REDIS_MAXMEMORY:-0}
sudo -u redis redis-cli config rewrite
sudo -u redis redis-cli config get maxmemory
