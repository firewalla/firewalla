#!/usr/bin/env bash
#
CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

test -e ${CUR_DIR}/../../files/fcc.service || exit 0
test -e ${CUR_DIR}/../../files/fcc.timer || exit 0


CHANGED=0

if ! cmp -s ${CUR_DIR}/../../files/fcc.service /etc/systemd/system/fcc.service; then
    sudo cp ${CUR_DIR}/../../files/fcc.service /etc/systemd/system/
    CHANGED=1
fi

if ! cmp -s ${CUR_DIR}/../../files/fcc.timer /etc/systemd/system/fcc.timer; then
    sudo cp ${CUR_DIR}/../../files/fcc.timer /etc/systemd/system/
    CHANGED=1
fi

if [[ "$CHANGED" -eq 1 ]]; then
    sudo systemctl daemon-reload
    # do not start here, it may kill upgrade task in fcc.service
    # sudo systemctl start fcc.service
fi

sudo systemctl start fcc.timer
