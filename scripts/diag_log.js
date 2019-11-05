'use strict'

const fwDiag = require("../extension/install/diag.js");
const program = require('commander');

program.version('1.0.0')
  .option('--data <data>', 'json data to send, string will send as { msg }')
  .option('--level <level>', 'log level', 'info')

program.parse(process.argv);

console.log(program.level)
console.log(program.data)

if (!program.data) {
  console.log("parameter data is required");
  process.exit(1);
}

(async () => {
  var json
  try {
    json = JSON.parse(program.data)
  } catch(e) {
    json = { msg: program.data }
  }

  await fwDiag.log(program.level, json);
  process.exit(0);
})().catch(err => {
  console.log('Error sending log', err);
  process.exit(1);
})
