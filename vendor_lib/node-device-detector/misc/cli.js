const readline = require('readline');
const DeviceDetector = require('../index');
const YAML = require('js-yaml');

const detector = new DeviceDetector;
const formats = ['json', 'yml'];
const format =
  process.argv[3] !== void 0 && formats.indexOf(process.argv[3]) !== -1
    ? process.argv[3]
    : 'json';

const print = process.argv[4] || 'no';

function parse(useragent) {
  let result = {user_agent: useragent};
  let botResult = detector.parseBot(useragent);
  if (botResult && botResult.name) {
    result = Object.assign(result, botResult);
  } else {
    result = Object.assign(result, detector.detect(useragent));
  }
  
  if (print === 'fixture') {
    if (result.client) {
      let osFamily = result.os.family;
      let clientFamily = result.client.family;
      result.client && result.client.short_name &&
      delete result.client.short_name;
      result.client && result.client.family && delete result.client.family;
      result.os && result.os.short_name && delete result.os.short_name;
      result.os && result.os.family && delete result.os.family;
      result.device && result.device.id && delete result.device.id;
      
      result['os_family'] = osFamily;
      result['browser_family'] = clientFamily;
    }
  }
  
  if (format === 'yml') {
    console.log(YAML.dump([result], {indent: 2, lineWidth: Infinity}));
    return;
  }
  if (format === 'json') {
    console.log(result);
    return;
  }
}
if (process.argv.length > 2) {
  parse(process.argv[2]);
  return;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('user agent: ', (userAgent) => {
  parse(userAgent);
  rl.close();
});
