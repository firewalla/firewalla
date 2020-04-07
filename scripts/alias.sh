#!/bin/bash

alias sudo='sudo '
alias apt='/home/pi/firewalla/scripts/apt.sh'
alias apt-get='/home/pi/firewalla/scripts/apt.sh'
alias tsys='sudo tail -F /var/log/syslog'
alias t0='tail -F ~/.forever/main.log'
alias t00='tail -F ~/.forever/*.log'
alias t1='tail -F ~/.forever/kickui.log'
alias t2='tail -F ~/.forever/monitor.log'
alias t3='tail -F ~/.forever/api.log'
alias t4='tail -F ~/.forever/blue.log'
alias t5='tail -F ~/.forever/firereset.log'
alias t6='tail -F ~/.forever/router.log'
alias tt0='tail -F ~/logs/FireMain.log'
alias tt00='tail -F ~/logs/Fire*.log'
alias tt1='tail -F ~/logs/FireKick.log'
alias tt2='tail -F ~/logs/FireMon.log'
alias tt3='tail -F ~/logs/FireApi.log'
alias l0='less -R ~/.forever/main.log'
alias l1='less -R ~/.forever/kickui.log'
alias l2='less -R ~/.forever/monitor.log'
alias l3='less -R ~/.forever/api.log'
alias l4='less -R ~/.forever/blue.log'
alias l5='less -R ~/.forever/firereset.log'
alias l6='less -R ~/.forever/router.log'
alias frr='forever restartall'
alias fr0='forever restart 0'
alias fr1='forever restart 1'
alias fr2='forever restart 2'
alias fr3='forever restart 3'
alias sr00='sudo systemctl restart fire{main,kick,mon,api}'
alias sr0='sudo systemctl restart firemain'
alias sr1='sudo systemctl restart firekick'
alias sr2='sudo systemctl restart firemon'
alias sr3='touch /home/pi/.firewalla/managed_reboot; sudo systemctl restart fireapi'
alias sr4='sudo systemctl restart firehttpd'
alias sr5='sudo systemctl restart firereset'
alias sr6='sudo systemctl restart firerouter'
alias srb4='sudo systemctl restart bitbridge4'
alias srb6='sudo systemctl restart bitbridge6'
alias ss7='sudo systemctl stop frpc.support.service'
alias sr4='sudo systemctl restart firehttpd'
alias fufu='sudo -u pi git fetch origin $branch && sudo -u pi git reset --hard FETCH_HEAD'
alias node='/home/pi/firewalla/bin/node'
alias fuc='/home/pi/firewalla/scripts/fireupgrade_check.sh'
alias srr='/home/pi/firewalla/scripts/main-run'
alias srrr='/home/pi/firewalla/scripts/fireupgrade_check.sh'
alias ct0='/home/pi/firewalla/scripts/estimate_compatibility.sh'
alias rc='redis-cli'
alias ll0='redis-cli publish "TO.FireMain" "{\"type\":\"ChangeLogLevel\", \"name\":\"*\", \"toProcess\":\"FireMain\", \"level\":\"info\"}"'
alias ll1='redis-cli publish "TO.FireKick" "{\"type\":\"ChangeLogLevel\", \"name\":\"*\", \"toProcess\":\"FireKick\", \"level\":\"info\"}"'
alias ll2='redis-cli publish "TO.FireMon" "{\"type\":\"ChangeLogLevel\", \"name\":\"*\", \"toProcess\":\"FireMon\", \"level\":\"info\"}"'
alias ll3='redis-cli publish "TO.FireApi" "{\"type\":\"ChangeLogLevel\", \"name\":\"*\", \"toProcess\":\"FireApi\", \"level\":\"info\"}"'
alias rrci='redis-cli publish "TO.FireMain" "{\"type\":\"CloudReCheckin\", \"toProcess\":\"FireMain\"}"'

alias scc='curl https://raw.githubusercontent.com/firewalla/firewalla/master/scripts/sanity_check.sh 2>/dev/null | bash -'
alias cbd='curl https://raw.githubusercontent.com/firewalla/firewalla/master/scripts/check_ipdomain_block.sh 2>/dev/null | bash /dev/stdin --domain'
alias cbi='curl https://raw.githubusercontent.com/firewalla/firewalla/master/scripts/check_ipdomain_block.sh 2>/dev/null | bash /dev/stdin --ip'
alias sccf='curl https://raw.githubusercontent.com/firewalla/firewalla/master/scripts/sanity_check.sh 2>/dev/null | bash /dev/stdin -f'
alias remote_speed_test='curl -s https://raw.githubusercontent.com/sivel/speedtest-cli/master/speedtest.py | python -'

alias less='less -r'

export PS1='\[\e]0;\u@\h: \w\a\]\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\] ($(redis-cli get groupName)) \$ '

alias powerup='source <(curl -s https://raw.githubusercontent.com/firewalla/firewalla/master/scripts/powerup.sh)'


function mycat () {
  curl https://raw.githubusercontent.com/firewalla/firewalla/master/scripts/cat.js > /tmp/cat.js 2>/dev/null
  node /tmp/cat.js --device "$1"
}

function mycatip () {
  curl https://raw.githubusercontent.com/firewalla/firewalla/master/scripts/cat.js > /tmp/cat.js 2>/dev/null
  node /tmp/cat.js --ip "$1"
}

alias ggalpha='cd /home/firewalla; scripts/switch_branch.sh beta_7_0 && /home/pi/firewalla/scripts/main-run'
