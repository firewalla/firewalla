# Notice

* Make sure node modules are well updated before submitting pull requests to firewalla repository
  * Node modules repository for armv7l: https://github.com/firewalla/fnm.node8.armv7l.git
* If change mgit, fire-ping, fireupgrade, check_reset, fireupgrade2.service, check_fix_network.sh  ... PLEASE CHANGE bootstrap.sha256sum
  * As an option, you can run command **cd .git; ln -s ../.githooks hooks** to enable sha256sum auto validation during commit