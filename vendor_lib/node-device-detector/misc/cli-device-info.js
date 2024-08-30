const DeviceInfo = require('../parser/device/info-device');
const YAML = require('../../../api/dist/lib/js-yaml.min.js');

const deviceInfo = new DeviceInfo();
deviceInfo.setResolutionConvertObject(true);
deviceInfo.setSizeConvertObject(true);

const REPORT_TYPE_YML = 'yml';
const REPORT_TYPE_JSON = 'json';

let brand = process.argv[2];
let model = process.argv[3];
let format = process.argv[4] || 'yml';

function printReport(result, format = 'yml') {
  if (REPORT_TYPE_YML === format) {
    console.log(YAML.dump([result], { indent: 2, lineWidth: Infinity }));
    return;
  }
  if (REPORT_TYPE_JSON === format) {
    console.log(result);
    return;
  }
}

let result = {
  brand: brand,
  model: model,
  result: deviceInfo.info(brand, model),
};

printReport(result, format);
