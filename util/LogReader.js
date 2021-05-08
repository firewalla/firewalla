const {spawn} = require('child_process');
const log = require('../net2/logger.js')(__filename);
const readline = require('readline');

class Tail {
  constructor(file, sudo = false) {
    this.file = file;
    this.sudo = sudo;
  }

  on(event, callback) {
    switch(event) {
    case "line":
      this.lineCallback = callback;
      break;
    }
  }

  watch() {
    log.info("Watching file", this.file);
    const cmd = this.sudo ? "sudo" : "tail";
    const args = this.sudo ? ["tail", "-F", this.file] : ["-F", this.file];

    const source = spawn(cmd, args,
                         { stdio: ['ignore', 'pipe', 'ignore'] }
                        );

    const reader = readline.createInterface({ input: source.stdout });
    
    reader.on('line', (line) => {
      if(this.lineCallback) {
        this.lineCallback(line);
      }
    });

    source.on('close', (code) => {
      log.warn("Watching file ended, should not happen in production");
    });
  }
}

module.exports = Tail;