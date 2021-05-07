function getNodeMajorVersion() {
  const v = process.versions.node;
  const items = v.split(".");
  if (items.length > 1) {
    return Number(items[0]);
  }

  return 0;
}

let chunksToLinesAsync = null;
let chomp = null;
let legacyTail = null;
let majorVersion = getNodeMajorVersion();

if(majorVersion >= 10) {
  const stringio = require('../vendor_lib/stringio.js');
  chomp = stringio.chomp;
  chunksToLinesAsync = stringio.chunksToLinesAsync;
} else {
  legacyTail = require('../vendor_lib/always-tail.js');
}

const {spawn} = require('child_process');
const log = require('../net2/logger.js')(__filename);

class Tail {
  constructor(file) {
	this.file = file;
  }

  on(event, callback) {
	switch(event) {
    case "line":
	  this.lineCallback = callback;
	  break;
    }
  }

  async watch() {
    if(majorVersion < 10) {
      this.legacyWatch();
      return;
    }
    log.info("Watching file", this.file);
    const source = spawn("tail",
                         ["-F", this.file],
                         { stdio: ['ignore', 'pipe', 'ignore'] }
                        );

    for await (const line of chunksToLinesAsync(source.stdout)) {
	  if(this.lineCallback) {
	    this.lineCallback(chomp(line));
      }
    }
  }

  legacyWatch() {
    this.log = new legacyTail(this.file, '\n');
    if (this.log != null) {
      log.info("Legacy Watching file", this.file);
      this.log.on('line', (data) => {
        if(this.lineCallback) {
          this.lineCallback(data);
        }
      });
      this.log.on('error', (err) => {
        log.error("Error while reading log", err.message);
      });
    }
  }
}
module.exports = Tail;