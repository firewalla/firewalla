#!/bin/bash

redis-cli keys 'tracking:*' | xargs -n 50 redis-cli del
