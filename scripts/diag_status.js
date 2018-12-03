'use strict'

const fwDiag = require("../extension/install/diag.js");
const program = require('commander');

program.version('0.0.1')
  .option('--event [event]', 'event')
  .option('--message [message]', 'message')

program.parse(process.argv);

if(!program.event || !program.message) {
  console.log("parameters event and message are required");
  process.exit(1);
}

(async () => {
  await fwDiag.submitInfo({
    event: program.event,
    msg: program.message
  });
  process.exit(0);
})();
