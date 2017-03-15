#!/bin/bash

# This script should only handle upgrade, nothing else

cd /home/pi/firewalla
cd .git
sudo chown -R pi *
cd ..
branch=$(git rev-parse --abbrev-ref HEAD)

GITHUB_STATUS_API=https://status.github.com/api.json

for i in `seq 1 5`; do
    HTTP_STATUS_CODE=`curl -s -o /dev/null -w "%{http_code}" $GITHUB_STATUS_API`
    if [[ $HTTP_STATUS_CODE == "200" ]]; then
      break;
    fi
    sleep 1
done


# continue to try upgrade even github api is not successfully.
# very likely to fail

if [[ ! -e "/home/pi/.firewalla/config/.no_auto_upgrade" ]]; then
  echo "upgrade on branch $branch"

  (sudo -u pi git fetch origin $branch && sudo -u pi git reset --hard FETCH_HEAD) || exit 1

  # in case there is some upgrade change on firewalla.service
  # all the rest services will be updated (in case) via firewalla.service
  sudo cp /home/pi/firewalla/etc/firewalla.service /etc/systemd/system/.
  sudo cp /home/pi/firewalla/etc/fireupgrade.service /etc/systemd/system/.
  sudo systemctl daemon-reload
  sudo systemctl reenable firewalla
  sudo systemctl reenable fireupgrade
fi
