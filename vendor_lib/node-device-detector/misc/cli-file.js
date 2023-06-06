const readline = require('readline');
const fs = require('fs');
const DeviceDetector = require('../index');
const YAML = require('js-yaml');
const detector = new DeviceDetector({ skipBotDetection: false });

const DETECT_MODE_TYPE_DETECT = 'detect';
const DETECT_MODE_TYPE_ALL = 'all';
const DETECT_MODE_TYPE_NOT = 'not';

const REPORT_TYPE_YML = 'yml';
const REPORT_TYPE_USERAGENT = 'useragent';
const REPORT_TYPE_JSON = 'json';

function printReport(result, format = 'yml') {
  if (REPORT_TYPE_YML === format) {
    console.log(YAML.dump([result], { indent: 2, lineWidth: Infinity }));
    return;
  }
  if (REPORT_TYPE_USERAGENT === format) {
    console.log(result.user_agent);
    return;
  }
  if (REPORT_TYPE_JSON === format) {
    console.log(result);
    return;
  }
}

if (process.argv.length < 2) {
  return;
}

let filePath = process.argv[2];
if (!fs.existsSync(filePath)) {
  console.error('file %c not found', filePath);
  return;
}
let detectMode = process.argv[3] || 'not';
let reportMode = process.argv[4] || 'yml';

const lineReader = readline.createInterface({
  input: fs.createReadStream(filePath),
  terminal: false,
});
lineReader.on('line', (useragent) => {
  let result = Object.assign(
    {
      user_agent: useragent,
    },
    detector.detect(useragent)
  );

  if (!useragent) {
    return true;
  }

  if (DETECT_MODE_TYPE_NOT === detectMode) {
    if ('' === result['device']['model']) {
      printReport(result, reportMode);
    }
  } else if (DETECT_MODE_TYPE_DETECT === detectMode) {
    if ('' !== result['device']['model']) {
      printReport(result, reportMode);
    }
  } else if (DETECT_MODE_TYPE_ALL === detectMode) {
    printReport(result, reportMode);
  }
});
