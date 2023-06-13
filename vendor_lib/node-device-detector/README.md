
# [node-device-detector](https://www.npmjs.com/package/node-device-detector)

_Last update: 04/05/2023_

## Description

Port php lib [matomo-org/device-detector](https://github.com/matomo-org/device-detector) to NodeJs

* [Online demo](https://mwfx8e.sse.codesandbox.io/)

## Code Status <a name="top"></a>

![Chai](https://github.com/sanchezzzhak/node-device-detector/workflows/Tests/badge.svg?branch=master)
![YAML Lint](https://github.com/sanchezzzhak/node-device-detector/workflows/YAML%20Lint/badge.svg?branch=master)
![Prettier](https://github.com/sanchezzzhak/node-device-detector/workflows/Prettier/badge.svg?branch=master)
![CodeQL](https://github.com/sanchezzzhak/node-device-detector/workflows/CodeQL/badge.svg?branch=master)
[![Featured on Openbase](https://badges.openbase.com/js/featured/node-device-detector.svg?token=5WrtsBbraPlUMJtKRE7o5w9fmuVUjXBHmiO0Pr/38v0=)](https://openbase.com/js/node-device-detector?utm_source=embedded&amp;utm_medium=badge&amp;utm_campaign=rate-badge)
## Contents

+ [Helpers](#helpers)
+ [Single parsers](#single-parsers)
+ [Settings](#options)
+ [Examples](#others)
+ [Support brands](#brands-list)
+ [Support device types](#device-types)
+ [Support browsers](#browsers-list)



Install
-
```
npm install node-device-detector --save
```
or 
```
yarn add node-device-detector
```
Usage
-
```js
// commonJS
const DeviceDetector = require('node-device-detector');
// or ESModule
import DeviceDetector from "node-device-detector";

const detector = new DeviceDetector({
  clientIndexes: true,
  deviceIndexes: true,
  deviceAliasCode: false,
});
const userAgent = 'Mozilla/5.0 (Linux; Android 5.0; NX505J Build/KVT49L) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/43.0.2357.78 Mobile Safari/537.36';
const result = detector.detect(userAgent);
console.log('result parse', result);
```
> PS: When creating an object`detector = new DeviceDetector;` data for parsing is reloaded from files, consider this, the best option is initialization at application start
> I recommend seeing [examples](#others)

### Result parse

```text
{ 
  os: { 
    name: 'Android',            // os name       
    short_name: 'AND',          // os short code name (format A-Z0-9{3})
    version: '5.0',             // os version
    platform: '',               // os platform (x64, x32, amd etc.)
    family: 'Android'           // os family
  },
  client:  { 
    type: 'browser',            // client type 
    name: 'Chrome Mobile',      // client name name
    short_name: 'CM',           // client short code name (only browser, format A-Z0-9{2,3})
    version: '43.0.2357.78',    // client version
    engine: 'Blink',            // client engine name (only browser)
    engine_version: ''          // client engine version (only browser)
    family: 'Chrome'            // client family (only browser)
  },
  device: { 
    id: 'ZT',                   // short code device brand name (format A-Z0-9{2,3})
    type: 'smartphone',         // device type
    brand: 'ZTE',               // device brand name
    model: 'Nubia Z7 max'       // device model name
    code: 'NX505J'              // device model code  (only result for enable detector.deviceAliasCode) 
  }
}
```

Result parse empty
```text
{ 
  os: {},                      // empty objects its os not found
  client: {},                  // empty objects its client not found
  device: {      
    id: '',                    // empty string its device brand not found
    type : 'device type',      // device type or empty string
    brand: '',                 // empty string its device brand not found
    model: ''                  // empty string its device model not found
  }
}
```

### Helpers<a name="helpers"></a> ###
[[top]](#top)

```js
// commonJS
const DeviceDetector = require('node-device-detector');
const DeviceHelper = require('node-device-detector/helper');
// or ESModule
import DeviceDetector from "node-device-detector";
import DeviceHelper from "node-device-detector/helper";

const detector = new DeviceDetector();
const userAgent = 'Mozilla/5.0 (Linux; Android 5.0; NX505J Build/KVT49L) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/43.0.2357.78 Mobile Safari/537.36';
const result = detector.detect(userAgent);

/* check device type (feature phone, smartphone or phablet) */
DeviceHelper.isMobile(result);
/* check device type is desktop */
DeviceHelper.isDesktop(result);
/* check device type is tablet  */
DeviceHelper.isTablet(result);
/* check device type car (side panel in car)  */
DeviceHelper.isCar(result);
/* check device type feature phone (push-button telephones)  */
DeviceHelper.isFeaturePhone(result);
/* check device type smartphone  */
DeviceHelper.isSmartphone(result);
/* check device type phablet  */
DeviceHelper.isPhablet(result);
/* check device type game console (xBox, PlayStation, Nintendo etc)  */
DeviceHelper.isConsole(result);
/* check device type smart speaker (Alisa, Alexa, HomePod etc) */
DeviceHelper.isSmartSpeaker(result);
/* check device type SmartTV/TV box */
DeviceHelper.isTv(result);
/* check device type portable camera */
DeviceHelper.isCamera(result);
/* portable terminal, portable projector */
DeviceHelper.isPeripheral(result);
/* LCD panel or interactive panel  */
DeviceHelper.isSmartDisplay(result);
/* check device type boxes, blu-ray players */
DeviceHelper.isPortableMediaPlayer(result);
/* check device type watches, headsets */
DeviceHelper.isWearable(result);
/* result device type number id */
DeviceHelper.getDeviceTypeId(result);
/* result device type string */
DeviceHelper.getDeviceType(result);
/* result client type string */
DeviceHelper.getClientType(result);
```

Using DeviceDetector + ClientHints
-
[[top]](#top)

```js
// commonJS
const DeviceDetector = require('node-device-detector');
const DeviceHelper   = require('node-device-detector/helper');
const ClientHints    = require('node-device-detector/client-hints');
// or ESModule
import DeviceDetector from "node-device-detector";
import DeviceHelper from "node-device-detector/helper";
import ClientHints from "node-device-detector/client-hints";

const detector = new DeviceDetector({
  clientIndexes: true,
  deviceIndexes: true,
  deviceAliasCode: false,
  // ... all options scroll to Setter/Getter/Options
});

const clientHints = new ClientHints();
const userAgent = res.headers['user-agent'];
const clientHintData = clientHints.parse(res.headers);
const result = detector.detect(userAgent, clientHintData);

// result promise
// added for 2.0.4 version or later
const result = detector.detectAsync(userAgent, clientHintData);
```

Using parsers singly <a name="single-parsers"></a>
-
[[top]](#top)

#### Detect Bot
```js
// commonJS
const DeviceDetector = require('node-device-detector');
// or ESModule
import DeviceDetector from "node-device-detector";

const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 6_0 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/6.0 Mobile/10A5376e Safari/8536.25 (compatible; Googlebot-Mobile/2.1; +http://www.google.com/bot.html)';
const detector = new DeviceDetector();
const result = detector.parseBot(userAgent);
```

#### Detect Os
```js
// commonJS
const DeviceDetector = require('node-device-detector');
// or ESModule
import DeviceDetector from "node-device-detector";

const userAgent = 'Mozilla/5.0 (Linux; Android 5.0; NX505J Build/KVT49L) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/43.0.2357.78 Mobile Safari/537.36';
const detector = new DeviceDetector({
  clientIndexes: true,
  deviceIndexes: true,
  deviceAliasCode: false,
});
const result = detector.parseOs(userAgent/*, clientHintData*/);
console.log('Result parse os', result);  
```

#### Detect Client 
```js
// commonJS
const DeviceDetector = require('node-device-detector');
// or ESModule
import DeviceDetector from "node-device-detector";

const userAgent = 'Mozilla/5.0 (Linux; Android 5.0; NX505J Build/KVT49L) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/43.0.2357.78 Mobile Safari/537.36';
const detector = new DeviceDetector({
    clientIndexes: true,
    deviceIndexes: true,
    deviceAliasCode: false,
});
const result = detector.parseClient(userAgent/*, clientHintData*/);
console.log('Result parse client', result);
```

#### Lite parse not detect brand
```js
// commonJS
const DeviceDetector = require('node-device-detector');
// or ESModule
import DeviceDetector from "node-device-detector";

const userAgent = 'Mozilla/5.0 (Linux; Android 5.0; NX505J Build/KVT49L) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/43.0.2357.78 Mobile Safari/537.36';
const detector = new DeviceDetector({
  clientIndexes: true,
  deviceIndexes: true,
  deviceAliasCode: false,
});
const resultOs = detector.parseOs(userAgent);
const resultClient = detector.parseClient(userAgent);
const resultDeviceType = detector.parseDeviceType(
 userAgent,
 resultOs,
 resultClient,
 {},
 /*, clientHintData */
);
const result = Object.assign({os:resultOs}, {client:resultClient}, {device: resultDeviceType});
console.log('Result parse lite', result);
```

### Getter/Setter/Options <a name="options"></a> ###
[[top]](#top)
```js
const detector = new DeviceDetector({
  osVersionTruncate: 0,      // Truncate OS version from 5.0 to 5 (default '' or null)
  clientVersionTruncate: 2,  // Truncate Client version Chrome from 43.0.2357.78 to 43.0.2357 (default '' or null)
  deviceIndexes: true,       // Using indexes for faster device search (default false)
  clientIndexes: true,       // Using indexes for faster client search (default false)
  deviceAliasCode: false,    // adds the device code to result device.code as is (default false)
  maxUserAgentSize: 500,     // uses only 500 chars from useragent string (default null - unlimited)
});

// You can override these settings at any time using special setters, example
detector.osVersionTruncate = 0;
detector.clientVersionTruncate = 2;
detector.deviceIndexes = true;
detector.clientIndexes = true;
detector.deviceAliasCode = true;
detector.maxUserAgentSize = 500;

// Array available device types
detector.getAvailableDeviceTypes();
// Array available devices brands
detector.getAvailableBrands();
// Array available browsers
detector.getAvailableBrowsers();
```

### Getting device code as it (experimental) <a name="device-code"></a>
[[top]](#top)
```js
const AliasDevice = require('node-device-detector/parser/device/alias-device');
const userAgent = 'Mozilla/5.0 (Linux; Android 5.0; NX505J Build/KVT49L) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/43.0.2357.78 Mobile Safari/537.36';
const aliasDevice = new AliasDevice;
const result = aliasDevice.parse(userAgent);
console.log('Result parse code model', result);
/*
result 
{
  name: "NX505J"
}
is not parse result  {name: ""}
*/
``` 

### What about performance?
```
node tests/banchmark.js test result:

Test Mozilla/5.0 (Linux; Android 5.0; NX505J Build/KVT49L) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/43.0.2357.78 Mobile Safari/537.36
-----
detector.parseDevice (deviceIndexes on) x 10,449 ops/sec ±0.27% (93 runs sampled)
detector.parseDevice (deviceIndexes off) x 261 ops/sec ±88.58% (92 runs sampled)
detector.parseClient (clientIndexes on) x 1,703 ops/sec ±0.36% (92 runs sampled)
detector.parseClient (clientIndexes off) x 859 ops/sec ±0.46% (93 runs sampled)
detector.parseOS x 10,034 ops/sec ±0.23% (94 runs sampled)
detector.detect (indexes off) x 254 ops/sec ±0.46% (85 runs sampled)
detector.detect (indexes on) x 1,114 ops/sec ±1.44% (91 runs sampled)
```
<details>
<summary>Other tests</summary>

```
Test Mozilla/5.0 (Linux; Android 12; M2101K9AG Build/SKQ1.210908.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/102.0.5005.125 Mobile Safari/537.36 UCURSOS/v1.6_273-android
-----
detector.parseDevice (deviceIndexes on) x 5,457 ops/sec ±0.23% (95 runs sampled)
detector.parseDevice (deviceIndexes off) x 220 ops/sec ±31.15% (87 runs sampled)
detector.parseClient (clientIndexes on) x 5,797 ops/sec ±0.32% (92 runs sampled)
detector.parseClient (clientIndexes off) x 6,243 ops/sec ±0.47% (93 runs sampled)
detector.parseOS x 7,570 ops/sec ±0.92% (93 runs sampled)
detector.detect (indexes off) x 203 ops/sec ±78.87% (86 runs sampled)
detector.detect (indexes on) x 1,695 ops/sec ±1.49% (88 runs sampled)

Test Mozilla/5.0 (Linux; Android 8.0.0; RNE-L21) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.0.0 Mobile Safari/537.36
-----
detector.parseDevice (deviceIndexes on) x 2,315 ops/sec ±0.62% (94 runs sampled)
detector.parseDevice (deviceIndexes off) x 448 ops/sec ±78.47% (89 runs sampled)
detector.parseClient (clientIndexes on) x 1,664 ops/sec ±0.69% (92 runs sampled)
detector.parseClient (clientIndexes off) x 844 ops/sec ±1.09% (93 runs sampled)
detector.parseOS x 10,258 ops/sec ±0.31% (95 runs sampled)
detector.detect (indexes off) x 254 ops/sec ±48.42% (89 runs sampled)
detector.detect (indexes on) x 808 ops/sec ±0.40% (92 runs sampled)
-----
Test Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.5005.124 Safari/537.36 Edg/102.0.1245.44
-----
detector.parseDevice (deviceIndexes on) x 8,387 ops/sec ±1.21% (94 runs sampled)
detector.parseDevice (deviceIndexes off) x 8,645 ops/sec ±0.32% (95 runs sampled)
detector.parseClient (clientIndexes on) x 1,751 ops/sec ±1.87% (91 runs sampled)
detector.parseClient (clientIndexes off) x 1,227 ops/sec ±0.57% (93 runs sampled)
detector.parseOS x 4,921 ops/sec ±0.25% (97 runs sampled)
detector.detect (indexes off) x 799 ops/sec ±1.04% (92 runs sampled)
detector.detect (indexes on) x 1,032 ops/sec ±0.61% (94 runs sampled)
-----
```
</details>

### What about tests?
Yes we use tests, total tests 67.5k

### Get more information about a device (experimental)
> This parser is experimental and contains few devices. (1815 devices, alias devices 3881)
>
##### Support detail brands/models list:

<details>
<summary>Show details</summary>

| Brand | Device count | Alias count | - | Brand | Device count | Alias count |
|----|----|----|----|----|----|----|
| 360 | 12 | 13 | - | 8848 | 4 | 0 |
| 2e | 2 | 2 | - | 3gnet | 0 | 1 |
| 3q | 14 | 62 | - | 4good | 10 | 1 |
| 4ife | 0 | 1 | - | a1 | 0 | 1 |
| accent | 0 | 5 | - | ace | 8 | 0 |
| acer | 5 | 68 | - | acteck | 0 | 0 |
| advan | 0 | 1 | - | advance | 0 | 14 |
| afrione | 0 | 2 | - | agm | 4 | 0 |
| ainol | 2 | 16 | - | airness | 0 | 0 |
| airo wireless | 1 | 0 | - | airties | 0 | 0 |
| ais | 0 | 2 | - | aiuto | 0 | 0 |
| aiwa | 0 | 0 | - | akai | 2 | 5 |
| alba | 0 | 1 | - | alcatel | 29 | 433 |
| alcor | 1 | 0 | - | alfawise | 0 | 0 |
| aligator | 0 | 0 | - | allcall | 0 | 3 |
| alldocube | 2 | 6 | - | allview | 0 | 46 |
| allwinner | 0 | 3 | - | altech uec | 0 | 0 |
| altek | 1 | 0 | - | altice | 0 | 0 |
| altron | 0 | 1 | - | amazon | 19 | 30 |
| amgoo | 2 | 15 | - | amigoo | 0 | 0 |
| amoi | 62 | 2 | - | andowl | 0 | 0 |
| anry | 0 | 0 | - | ans | 0 | 0 |
| aoc | 0 | 0 | - | aoson | 0 | 6 |
| apple | 46 | 44 | - | archos | 89 | 7 |
| arian space | 4 | 2 | - | ark | 1 | 36 |
| armphone | 0 | 0 | - | arnova | 0 | 36 |
| arris | 0 | 0 | - | artel | 0 | 2 |
| artizlee | 0 | 1 | - | asano | 0 | 1 |
| asanzo | 1 | 0 | - | ask | 0 | 0 |
| assistant | 2 | 19 | - | asus | 81 | 230 |
| at&t | 1 | 2 | - | atom | 0 | 3 |
| atvio | 0 | 0 | - | avenzo | 1 | 3 |
| avh | 1 | 0 | - | avvio | 3 | 2 |
| axxion | 0 | 0 | - | azumi mobile | 0 | 1 |
| bangolufsen | 0 | 0 | - | barnes & noble | 1 | 6 |
| bb mobile | 2 | 10 | - | beeline | 11 | 1 |
| bellphone | 1 | 1 | - | benq | 0 | 1 |
| beyond | 0 | 7 | - | bezkam | 1 | 0 |
| bigben | 1 | 0 | - | bihee | 2 | 1 |
| billion | 1 | 1 | - | bird | 1 | 0 |
| bitel | 4 | 1 | - | bitmore | 2 | 1 |
| bkav | 1 | 0 | - | black bear | 2 | 0 |
| black fox | 18 | 12 | - | blackview | 15 | 9 |
| blu | 13 | 15 | - | bravis | 24 | 17 |
| cgv | 1 | 0 | - | clarmin | 3 | 0 |
| colors | 7 | 2 | - | cyrus | 1 | 0 |
| digifors | 1 | 1 | - | engel | 1 | 1 |
| firefly mobile | 4 | 1 | - | formuler | 2 | 0 |
| geotel | 3 | 0 | - | gionee | 4 | 0 |
| google | 3 | 5 | - | hisense | 2 | 0 |
| hoffmann | 1 | 1 | - | hotwav | 18 | 1 |
| huawei | 226 | 586 | - | i-mobile | 1 | 0 |
| imo mobile | 5 | 0 | - | infinix | 26 | 40 |
| inoi | 4 | 0 | - | intex | 18 | 3 |
| ipro | 6 | 7 | - | irbis | 15 | 0 |
| kiowa | 1 | 0 | - | kurio | 3 | 3 |
| lg | 127 | 286 | - | malata | 1 | 0 |
| maze | 4 | 0 | - | minix | 1 | 1 |
| mivo | 3 | 2 | - | mobicel | 3 | 1 |
| motorola | 27 | 24 | - | noa | 1 | 0 |
| nomi | 1 | 1 | - | nuu mobile | 9 | 3 |
| nuvo | 3 | 2 | - | oneplus | 18 | 48 |
| oppo | 103 | 202 | - | oukitel | 8 | 0 |
| öwn | 1 | 2 | - | panasonic | 5 | 8 |
| pipo | 5 | 0 | - | poco | 8 | 14 |
| realme | 65 | 94 | - | samsung | 167 | 714 |
| sony | 44 | 172 | - | supra | 1 | 0 |
| tecno mobile | 91 | 131 | - | tiphone | 1 | 0 |
| utok | 1 | 0 | - | uz mobile | 1 | 0 |
| vernee | 9 | 2 | - | vivo | 196 | 286 |
| walton | 13 | 0 | - | we | 8 | 0 |
| weimei | 1 | 0 | - | wiko | 7 | 12 |
| wileyfox | 9 | 0 | - | wink | 4 | 0 |
| zync | 2 | 0 | - | zyq | 1 | 13 |

</details>

```js
const InfoDevice = require('node-device-detector/parser/device/info-device');
const infoDevice = new InfoDevice;
const result = infoDevice.info('Asus', 'Zenfone 4');
console.log('Result information', result);
/*
result
{
  display: {
    size: '5.5',
    resolution: '1080x1920',  // width+height
    ratio: '16:9',
    ppi: "401"
  },
  size: '155.4x75.2x7.7',    // width+height+thickness
  weight: '165',
  hardware: {
    // ...
  }
  os: "Android 7.1",
  release: "2017.08",
  sim": "2",
}
is not found result null
*/
```
Cast methods
```js
const InfoDevice = require('node-device-detector/parser/device/info-device');
const infoDevice = new InfoDevice;
infoDevice.setSizeConvertObject(true);
infoDevice.setResolutionConvertObject(true);
const result = infoDevice.info('Asus', 'Zenfone 4');
console.log('Result information', result);
/*
result
{  
  display: {
    size: "5.5",  // value in inchs
    resolution: {
      width: "1080", // value in px
      height: "1920" // value in px
    },
    ratio: "16:9",   // calculated field
    ppi: "401"       // calculated field
  },
  hardware: {
    ram: "4096",   // RAM value in megabytes
    cpu_id: 19,  // id cpu model in collection
    cpu: {
      name: "Qualcomm Snapdragon 630",  // brand + name
      type: "ARM",                      // architecture type 
      cores: "8",                       // number of cores / threads 
      clock_rate: 2200,                 // value in MHz
      gpu_id: 16                        // id gpu model in collection
	},
    gpu: {
      name: "Qualcomm Adreno 508",
      clock_rate: 650
    }
  },
  os: "Android 7.1",   // initial OS version
  release: "2017.08",  // date release or anonce
  sim": "2",           // count SIM 
  size: {           
    width: "75.2",     // physical width in millimeters
    height: "155.4",   // physical height in millimeters
    thickness: "7.7"   // physical thickness in millimeters
  },
  weight: "165"        // in grams
};
*/
```

Others <a name="others"></a>
-
[[top]](#top)

##### Examples
* [detect device in native server](docs/NATIVE_SERVER.MD)
* [detect device + client hints in native server](docs/CLIENT_HINT_NATIVE_SERVER.MD)
* [detect device in express.js](docs/EXPRESS_SERVER.MD)
* [detect device in moleculer.js](docs/MICROSERVICE.MD)
* [detect device in uws.js](docs/UWS_SERVER.MD)
* [detect device in typescript](docs/TYPE_SCRIPT.MD)

<a name="brands-list"></a>

##### Support detect brands list (1628):

<details>
<summary>Show details</summary>

  Brand  |  Brand  |  Brand  |  Brand  |  Brand  |  Brand  |  Brand 
--- | --- | --- | --- | --- | --- | ---
10moons | 2E | 360 | 3GNET | 3GO | 3Q | 4Good
4ife | 7 Mobile | 8848 | A1 | Accent | Ace | Acer
Acteck | actiMirror | Adronix | Advan | Advance | Advantage Air | AFFIX
AfriOne | AG Mobile | AGM | AIDATA | Ainol | Airis | Airness
AIRON | Airpha | Airtel | Airties | AIS | Aiuto | Aiwa
Akai | AKIRA | Alba | Alcatel | Alcor | ALDI NORD | ALDI SÜD
Alfawise | Aligator | AllCall | AllDocube | ALLINmobile | Allview | Allwinner
Alps | Altech UEC | Altice | altron | AMA | Amazon | AMCV
AMGOO | Amigoo | Amino | Amoi | Andowl | Angelcare | Anker
Anry | ANS | ANXONIT | AOC | Aocos | AOpen | Aoro
Aoson | AOYODKG | Apple | Aquarius | Archos | Arian Space | Ark
ArmPhone | Arnova | ARRIS | Artel | Artizlee | ArtLine | Asano
Asanzo | Ask | Aspera | ASSE | Assistant | Astro | Asus
AT&T | Athesi | Atmaca Elektronik | ATMAN | ATOL | Atom | Attila
Atvio | Audiovox | AURIS | Autan | AUX | Avaya | Avenzo
AVH | Avvio | Awow | Axioo | AXXA | Axxion | AYYA
Azumi Mobile | b2m | Backcell | BangOlufsen | Barnes & Noble | BB Mobile | BBK
BDF | BDQ | BDsharing | Beafon | Becker | Beeline | Beelink
Beetel | Beista | Bellphone | Benco | Benesse | BenQ | BenQ-Siemens
BenWee | Benzo | Beyond | Bezkam | BGH | Bigben | BIHEE
BilimLand | Billion | Billow | BioRugged | Bird | Bitel | Bitmore
Bittium | Bkav | Black Bear | Black Fox | Blackpcs | Blackview | Blaupunkt
Bleck | BLISS | Blloc | Blow | Blu | Bluboo | Bluebird
Bluedot | Bluegood | BlueSky | Bluewave | BluSlate | BMAX | Bmobile
BMXC | Bobarry | bogo | Bookeen | Boost | Boway | bq
BrandCode | Brandt | BRAVE | Bravis | BrightSign | Brigmton | Brondi
BROR | BS Mobile | Bubblegum | Bundy | Bush | BuzzTV | C5 Mobile
CAGI | Camfone | Canal Digital | Capitel | Captiva | Carbon Mobile | Carrefour
Casio | Casper | Cat | Cavion | Ceibal | Celcus | Celkon
Cell-C | Cellacom | CellAllure | Cellution | Centric | CG Mobile | CGV
Chainway | Changhong | Cherry Mobile | Chico Mobile | ChiliGreen | China Mobile | China Telecom
Chuwi | CipherLab | Citycall | Claresta | Clarmin | ClearPHONE | Clementoni
Cloud | Cloudfone | Cloudpad | Clout | CnM | Cobalt | Coby Kyros
Colors | Comio | Compal | Compaq | COMPUMAX | ComTrade Tesla | Concord
ConCorde | Condor | Connectce | Connex | Conquest | Contixo | Coolpad
Coopers | CORN | Cosmote | Covia | Cowon | COYOTE | CreNova
Crescent | Cricket | Crius Mea | Crony | Crosscall | Crown | Ctroniq
Cube | CUBOT | CVTE | Cwowdefu | Cyrus | D-Link | D-Tech
Daewoo | Danew | Dany | DASS | Datalogic | Datamini | Datang
Datawind | Datsun | Dazen | DbPhone | Dbtel | Dcode | DEALDIG
Dell | Denali | Denver | Desay | DeWalt | DEXP | DEYI
DF | DGTEC | Dialog | Dicam | Digi | Digicel | DIGICOM
Digidragon | DIGIFORS | Digihome | Digiland | Digit4G | Digma | DIMO
Dinax | DING DING | DISH | Ditecma | Diva | DiverMax | Divisat
DIXON | DL | DMM | DNS | DoCoMo | Doffler | Dolamee
Dom.ru | Doogee | Doopro | Doov | Dopod | Doppio | DORLAND
Doro | DRAGON | Dragon Touch | Dreamgate | DreamStar | DreamTab | Droxio
DSIC | Dtac | Dune HD | DUNNS Mobile | Duubee | E-Boda | E-Ceros
E-tel | Eagle | Easypix | EBEN | EBEST | Echo Mobiles | ecom
ECON | ECOO | ECS | EE | EFT | EGL | Einstein
EKO | Eks Mobility | EKT | ELARI | Elecson | Electroneum | ELECTRONIA
Elekta | Element | Elenberg | Elephone | Elevate | Elong Mobile | Eltex
Ematic | Emporia | ENACOM | Energizer | Energy Sistem | Engel | ENIE
Enot | eNOVA | Entity | Envizen | Ephone | Epik One | Epson
Equator | Ergo | Ericsson | Ericy | Erisson | Essential | Essentielb
eSTAR | Eton | eTouch | Etuline | Eurocase | Eurostar | Evercoss
Everest | Everex | Evertek | Evolio | Evolveo | Evoo | EVPAD
EvroMedia | EWIS | EXCEED | Exmart | ExMobile | EXO | Explay
Extrem | EYU | Ezio | Ezze | F&U | F150 | F2 Mobile
Facebook | Facetel | Facime | Fairphone | Famoco | Famous | Fantec
FaRao Pro | Farassoo | FarEasTone | Fengxiang | FEONAL | Fero | FFF SmartLife
Figgers | FiGi | FiGO | FiiO | FILIX | FinePower | Finlux
FireFly Mobile | FISE | Fluo | Fly | FLYCAT | FMT | FNB
FNF | Fondi | Fonos | FOODO | FORME | Formuler | Forstar
Fortis | Four Mobile | Fourel | Foxconn | FoxxD | FPT | Freetel
Frunsi | Fuego | Fujitsu | Funai | Fusion5 | Future Mobile Technology | Fxtec
G-TiDE | G-Touch | Galaxy Innovations | Garmin-Asus | Gateway | Gazer | Geanee
Gear Mobile | Gemini | General Mobile | Genesis | GEOFOX | Geotel | Geotex
GEOZON | GFive | Ghia | Ghong | Ghost | Gigabyte | Gigaset
Gini | Ginzzu | Gionee | GIRASOLE | Globex | Glofiish | GLONYX
GLX | GOCLEVER | Gocomma | GoGEN | Gol Mobile | GoldMaster | Goly
Gome | GoMobile | GOODTEL | Google | Goophone | Gooweel | Gplus
Gradiente | Grape | Great Asia | Gree | Greentel | Gresso | Gretel
Grundig | Gtel | GTMEDIA | Guophone | H133 | H96 | Hafury
Haier | Haipai | Hamlet | Hammer | Handheld | HannSpree | HAOQIN
HAOVM | Hardkernel | Harper | Hartens | Hasee | HDC | HeadWolf
Helio | HERO | HexaByte | Hezire | Hi | Hi Nova | Hi-Level
Hiberg | High Q | Highscreen | HiHi | HiKing | HiMax | HIPER
Hipstreet | Hisense | Hitachi | Hitech | HKPro | HLLO | Hoffmann
Hometech | Homtom | Honeywell | Hoozo | Horizon | Horizont | Hosin
Hot Pepper | Hotel | HOTREALS | Hotwav | How | HP | HTC
Huadoo | Huagan | Huavi | Huawei | Hugerock | Humax | Hurricane
Huskee | Hykker | Hyrican | Hytera | Hyundai | Hyve | i-Cherry
I-INN | i-Joy | i-mate | i-mobile | iBall | iBerry | iBrit
IconBIT | iData | iDroid | iGet | iHunt | Ikea | IKI Mobile
iKoMo | iKon | IKU Mobile | iLA | iLife | iMan | iMars
iMI | IMO Mobile | Imose | Impression | iMuz | iNavi | INCAR
Inch | Inco | iNew | Infiniton | Infinix | InFocus | InfoKit
InFone | Inhon | Inkti | InnJoo | Innos | Innostream | iNo Mobile
Inoi | iNOVA | INQ | Insignia | INSYS | Intek | Intel
Intex | Invens | Inverto | Invin | iOcean | iOutdoor | iPEGTOP
iPro | iQ&T | IQM | IRA | Irbis | iReplace | Iris
iRobot | iRola | iRulu | iSafe Mobile | iStar | iSWAG | IT
iTel | iTruck | IUNI | iVA | iView | iVooMi | ivvi
iWaylink | iXTech | iYou | iZotron | JAY-Tech | Jedi | Jeka
Jesy | JFone | Jiake | Jiayu | Jinga | Jio | Jivi
JKL | Jolla | Joy | JoySurf | JPay | JREN | Jumper
Juniper Systems | Just5 | JVC | JXD | K-Lite | K-Touch | Kaan
Kaiomy | Kalley | Kanji | Kapsys | Karbonn | Kata | KATV1
Kazam | Kazuna | KDDI | Kempler & Strauss | Kenbo | Keneksi | Kenxinda
Khadas | Kiano | Kingbox | Kingstar | Kingsun | KINGZONE | Kinstone
Kiowa | Kivi | Klipad | Kocaso | Kodak | Kogan | Komu
Konka | Konrow | Koobee | Koolnee | Kooper | KOPO | Koridy
Koslam | Kraft | KREZ | KRIP | KRONO | Krüger&Matz | KT-Tech
KUBO | Kuliao | Kult | Kumai | Kurio | Kvant | Kyocera
Kyowon | Kzen | KZG | L-Max | LAIQ | Land Rover | Landvo
Lanin | Lanix | Lark | Laurus | Lava | LCT | Le Pan
Leader Phone | Leagoo | Leben | LeBest | Lectrus | Ledstar | LeEco
Leelbox | Leff | Legend | Leke | LEMFO | Lemhoov | Lenco
Lenovo | Leotec | Lephone | Lesia | Lexand | Lexibook | LG
Liberton | Lifemaxx | Lingwin | Linnex | Linsar | Linsay | Listo
LNMBBS | Loewe | Logic | Logic Instrument | Logicom | LOKMAT | Loview
Lovme | LPX-G | LT Mobile | Lumigon | Lumitel | Lumus | Luna
Luxor | LYF | M-Horse | M-Tech | M.T.T. | M3 Mobile | M4tel
MAC AUDIO | Macoox | Mafe | Magicsee | Magnus | Majestic | Malata
Mango | Manhattan | Mann | Manta Multimedia | Mantra | Mara | Marshal
Mascom | Massgo | Masstel | Master-G | Mastertech | Matrix | Maxcom
Maxfone | Maximus | Maxtron | MAXVI | Maxwest | MAXX | Maze
Maze Speed | MBI | MBOX | MDC Store | MDTV | meanIT | Mecer
Mecool | Mediacom | MediaTek | Medion | MEEG | MegaFon | Meitu
Meizu | Melrose | Memup | Meta | Metz | MEU | MicroMax
Microsoft | Microtech | Minix | Mint | Mintt | Mio | Mione
Miray | Mito | Mitsubishi | Mitsui | MIVO | MIWANG | MIXC
MiXzo | MLLED | MLS | MMI | Mobell | Mobicel | MobiIoT
Mobiistar | Mobile Kingdom | Mobiola | Mobistel | MobiWire | Mobo | Modecom
Mofut | Mosimosi | Motiv | Motorola | Movic | MOVISUN | Movitel
Moxee | mPhone | Mpman | MSI | MStar | MTC | MTN
Multilaser | MwalimuPlus | MYFON | MyGica | MygPad | Mymaga | MyMobile
MyPhone | Myria | Myros | Mystery | MyTab | MyWigo | Nabi
Naomi Phone | NASCO | National | Navcity | Navitech | Navitel | Navon
NavRoad | NEC | Necnot | Nedaphone | Neffos | NEKO | Neo
neoCore | Neolix | Neomi | Neon IQ | Netgear | Netmak | NeuImage
NeuTab | New Balance | New Bridge | Newgen | Newland | Newman | Newsday
NewsMy | Nexa | NEXBOX | Nexian | NEXON | NEXT | Nextbit
NextBook | NextTab | NG Optics | NGM | NGpon | Nikon | NINETEC
Nintendo | nJoy | NOA | Noain | Nobby | Noblex | NOBUX
NOGA | Nokia | Nomi | Nomu | Noontec | Nordmende | NorthTech
Nos | Nothing Phone | Nous | Novex | Novey | NOVO | NTT West
NuAns | Nubia | NUU Mobile | NuVision | Nuvo | Nvidia | NYX Mobile
O+ | O2 | Oale | Oangcc | OASYS | Obabox | Ober
Obi | Odotpad | Odys | OINOM | Ok | Okapia | Oking
OKSI | OKWU | Olax | Olkya | Ollee | OLTO | Olympia
OMIX | Onda | OneClick | OneLern | OnePlus | Onix | Onkyo
ONN | ONYX BOOX | Ookee | OpelMobile | Openbox | Ophone | OPPO
Opsson | Optoma | Orange | Orbic | Orbita | Orbsmart | Ordissimo
Orion | OSCAL | OTTO | OUJIA | Ouki | Oukitel | OUYA
Overmax | Ovvi | öwn | Owwo | OYSIN | Oysters | Oyyu
OzoneHD | P-UP | Packard Bell | Paladin | Palm | Panacom | Panasonic
Pano | Pantech | PAPYRE | Parrot Mobile | Partner Mobile | PC Smart | PCBOX
PCD | PCD Argentina | PEAQ | Pelitt | Pendoo | Pentagram | Perfeo
Phicomm | Philco | Philips | Phonemax | phoneOne | Pico | PINE
Pioneer | Pioneer Computers | PiPO | PIRANHA | Pixela | Pixelphone | Pixus
Planet Computers | Ployer | Plum | PlusStyle | Pluzz | PocketBook | POCO
Point Mobile | Point of View | Polar | PolarLine | Polaroid | Polestar | PolyPad
Polytron | Pomp | Poppox | POPTEL | Porsche | Positivo | Positivo BGH
PPTV | Premio | Prestigio | PRIME | Primepad | Primux | Pritom
Prixton | PROFiLO | Proline | Prology | ProScan | Protruly | ProVision
PULID | Punos | Purism | Q-Box | Q-Touch | Q.Bell | QFX
Qilive | QLink | QMobile | Qnet Mobile | QTECH | Qtek | Quantum
Quatro | Qubo | Quechua | Quest | Quipus | Qumo | Qware
R-TV | Rakuten | Ramos | Raspberry | Ravoz | Raylandz | Razer
RCA Tablets | Reach | Readboy | Realme | RED | Redbean | Redfox
RedLine | Redway | Reeder | REGAL | RelNAT | Remdun | Retroid Pocket
Revo | Revomovil | Ricoh | Rikomagic | RIM | Rinno | Ritmix
Ritzviva | Riviera | Rivo | Rizzen | ROADMAX | Roadrover | Roam Cat
ROiK | Rokit | Roku | Rombica | Ross&Moor | Rover | RoverPad
Royole | RoyQueen | RT Project | RugGear | RuggeTech | Ruggex | Ruio
Runbo | Rupa | Ryte | S-TELL | S2Tel | Saba | Safaricom
Sagem | Saiet | Salora | Samsung | Samtech | Samtron | Sanei
Sankey | Sansui | Santin | SANY | Sanyo | Savio | SCBC
Schneider | Schok | Scosmos | Seatel | SEBBE | Seeken | SEG
Sega | Selecline | Selenga | Selevision | Selfix | SEMP TCL | Sencor
Sendo | Senkatel | Senseit | Senwa | Seuic | Sewoo | SFR
SGIN | Shanling | Sharp | Shift Phones | Shivaki | Shtrikh-M | Shuttle
Sico | Siemens | Sigma | Silelis | Silent Circle | Simbans | Simply
Singtech | Siragon | Sirin Labs | SK Broadband | SKG | SKK Mobile | Sky
Skyline | Skyworth | Smadl | Smailo | Smart | Smart Electronic | Smart Kassel
Smartab | SmartBook | SMARTEC | Smartex | Smartfren | Smartisan | Smarty
Smooth Mobile | Smotreshka | SNAMI | Soda | Softbank | Soho Style | SOLE
SOLO | Solone | Sonim | SONOS | Sony | Sony Ericsson | SOSH
Soundmax | Soyes | Spark | SPC | Spectralink | Spectrum | Spice
Sprint | SQOOL | SSKY | Star | Starlight | Starmobile | Starway
Starwind | STF Mobile | STG Telecom | STK | Stonex | Storex | StrawBerry
Stream | STRONG | Stylo | Subor | Sugar | Sumvision | Sunmax
Sunmi | Sunny | Sunstech | SunVan | Sunvell | SUNWIND | SuperBOX
SuperSonic | SuperTab | Supra | Surge | Suzuki | Swipe | SWISSMOBILITY
Swisstone | Switel | SWTV | Syco | SYH | Sylvania | Symphony
Syrox | T-Mobile | T96 | TAG Tech | Taiga System | Takara | Talius
Tambo | Tanix | TB Touch | TCL | TD Systems | TD Tech | TeachTouch
Technicolor | Technika | TechniSat | Technopc | TechnoTrend | TechPad | Techwood
Teclast | Tecno Mobile | TecToy | TEENO | Teknosa | Tele2 | Telefunken
Telego | Telenor | Telia | Telit | Telma | TeloSystems | Telpo
TENPLUS | Teracube | Tesco | Tesla | TETC | Tetratab | teXet
ThL | Thomson | Thuraya | TIANYU | Tibuta | Tigers | Time2
Timovi | TIMvision | Tinai | Tinmo | TiPhone | TiVo | TJC
TOKYO | Tolino | Tone | Tooky | Top House | TopDevice | TOPDON
Topelotek | Toplux | Topsion | Topway | Torex | Torque | TOSCIDO
Toshiba | Touch Plus | Touchmate | TOX | Transpeed | TrekStor | Trevi
Trident | Trifone | Trio | Tronsmart | True | True Slim | TTEC
TTK-TV | TuCEL | Tunisie Telecom | Turbo | Turbo-X | TurboKids | TurboPad
Türk Telekom | Turkcell | TVC | TWM | Twoe | TWZ | Tymes
U-Magic | U.S. Cellular | UE | Ugoos | Uhans | Uhappy | Ulefone
Umax | UMIDIGI | Unblock Tech | Uniden | Unihertz | Unimax | Uniqcell
Uniscope | Unistrong | Unitech | UNIWA | Unknown | Unnecto | Unnion Technologies
UNNO | Unonu | Unowhy | Urovo | UTime | UTOK | UTStarcom
UZ Mobile | V-Gen | V-HOME | V-HOPE | v-mobile | VAIO | VALEM
VALTECH | Vankyo | Vargo | Vastking | VAVA | VC | VDVD
Vega | Venso | Venstar | Venturer | VEON | Verico | Verizon
Vernee | Verssed | Versus | Vertex | Vertu | Verykool | Vesta
Vestel | Vexia | VGO TEL | ViBox | Victurio | VIDA | Videocon
Videoweb | ViewSonic | VIIPOO | Vinabox | Vinga | Vinsoc | Vios
Viper | Vipro | Virzo | Vision Touch | Vitelcom | Vityaz | Viumee
Vivax | VIVIMAGE | Vivo | VIWA | Vizio | Vizmo | VK Mobile
VKworld | Vodacom | Vodafone | VOGA | Völfen | Volt | Vonino
Vontar | Vorago | Vorcom | Vorke | Vormor | Vortex | Voto
VOX | Voxtel | Voyo | Vsmart | Vsun | VUCATIMES | Vue Micro
Vulcan | VVETIME | Walton | Waltter | Wanmukang | WANSA | WE
Web TV | Webfleet | Wecool | Weelikeit | Weimei | WellcoM | WELLINGTON
Western Digital | Westpoint | Wexler | White Mobile | Wieppo | Wigor | Wiko
Wileyfox | Winds | Wink | Winmax | Winnovo | Winstar | Wintouch
Wiseasy | WIWA | WizarPos | Wizz | Wolder | Wolfgang | Wolki
Wonu | Woo | Wortmann | Woxter | X-AGE | X-BO | X-Mobile
X-TIGI | X-View | X.Vision | X88 | X96 | X96Q | XCOM
Xcruiser | XElectron | XGIMI | Xgody | Xiaodu | Xiaolajiao | Xiaomi
Xion | Xolo | Xoro | Xshitou | Xtouch | Xtratech | Xwave
XY Auto | Yandex | Yarvik | YASIN | YELLYOUTH | YEPEN | Yes
Yestel | Yezz | Yoka TV | Yooz | Yota | YOTOPT | Youin
Youwei | Ytone | Yu | YU Fly | Yuandao | YUHO | YUMKEM
YUNDOO | Yuno | YunSong | Yusun | Yxtel | Zaith | Zamolxe
Zatec | Zealot | Zebra | Zeeker | Zeemi | Zen | Zenek
Zentality | Zfiner | ZH&K | Zidoo | ZIFRO | ZIK | Zinox
Ziox | Zonda | Zonko | Zoom | ZoomSmart | Zopo | ZTE
Zuum | Zync | ZYQ | Zyrex


</details>

[[top]](#top)

<a name="device-types"></a>
<details>
<summary>Support device types:</summary>

| type | id |
| ----  | ---- |
| desktop | 0 |
| smartphone | 1 |
| tablet | 2 |
| feature phone | 3 |
| console | 4 |
| tv | 5 |
| car browser | 6 |
| smart display | 7 | 
| camera | 8 |
| portable media player | 9 |
| phablet | 10 |
| smart speaker | 11 |
| wearable | 12 |
| peripheral | 13 |

</details>


##### Support detect browsers list (503):

<details>
<summary>Show details</summary>

  Browser  |  Browser  |  Browser  |  Browser  |  Browser  |  Browser  |  Browser 
--- | --- | --- | --- | --- | --- | ---
115 Browser | 18+ Privacy Browser | 1DM Browser | 1DM+ Browser | 2345 Browser | 360 Browser | 360 Phone Browser
7654 Browser | 7Star | ABrowse | AdBlock Browser | Adult Browser | Aloha Browser | Aloha Browser Lite
Amaya | Amaze Browser | Amerigo | Amiga Aweb | Amiga Voyager | Amigo | Android Browser
Anka Browser | ANT Fresco | ANTGalio | AOL Desktop | AOL Shield | AOL Shield Pro | APN Browser
AppBrowzer | APUS Browser | Arctic Fox | Arora | Arvin | Ask.com | Asus Browser
Atlas | Atom | Atomic Web Browser | Avant Browser | Avast Secure Browser | AVG Secure Browser | Avira Scout
AwoX | Azka Browser | B-Line | Baidu Browser | Baidu Spark | Bangla Browser | Basilisk
Beaker Browser | Beamrise | Belva Browser | Beonex | Berry Browser | Beyond Private Browser | BF Browser
Bitchute Browser | Biyubi | Black Lion Browser | BlackBerry Browser | BlackHawk | Bloket | Blue Browser
Bonsai | Borealis Navigator | Brave | BriskBard | Browlser | BrowseHere | Browser Hup Pro
BrowseX | Browspeed Browser | Browzar | Bunjalloo | Byffox | Cake Browser | Camino
CCleaner | Centaury | CG Browser | ChanjetCloud | Charon | Chedot | Cheetah Browser
Cherry Browser | Cheshire | Chim Lac | Chowbo | Chrome | Chrome Frame | Chrome Mobile
Chrome Mobile iOS | Chrome Webview | ChromePlus | Chromium | Chromium GOST | CM Browser | CM Mini
Coast | Coc Coc | Colibri | CometBird | Comfort Browser | Comodo Dragon | Conkeror
CoolBrowser | CoolNovo | Cornowser | COS Browser | Craving Explorer | Crazy Browser | Crusta
Cunaguaro | Cyberfox | CyBrowser | Dark Web Browser | dbrowser | Debuggable Browser | Decentr
Deepnet Explorer | deg-degan | Deledao | Delta Browser | Desi Browser | DeskBrowse | Dillo
Dolphin | Dolphin Zero | Dooble | Dorado | Dot Browser | Dragon Browser | DUC Browser
DuckDuckGo Privacy Browser | Easy Browser | Ecosia | Edge WebView | EinkBro | Element Browser | Elements Browser
Elinks | Epic | Espial TV Browser | EUI Browser | Explore Browser | eZ Browser | Falkon
Fast Browser UC Lite | Fast Explorer | Faux Browser | Fennec | Fiery Browser | Firebird | Firefox
Firefox Focus | Firefox Klar | Firefox Mobile | Firefox Mobile iOS | Firefox Reality | Firefox Rocket | Fireweb
Fireweb Navigator | Flash Browser | Flast | Float Browser | Flock | Floorp | Flow
Flow Browser | Fluid | Flyperlink | FreeU | Frost+ | Fulldive | G Browser
Galeon | Gener8 | Ghostery Privacy Browser | GinxDroid Browser | Glass Browser | GNOME Web | GoBrowser
GOG Galaxy | Google Earth | Google Earth Pro | Harman Browser | HasBrowser | Hawk Quick Browser | Hawk Turbo Browser
Headless Chrome | Helio | Hexa Web Browser | Hi Browser | hola! Browser | HotJava | HTC Browser
Huawei Browser | Huawei Browser Mobile | HUB Browser | IBrowse | iBrowser | iBrowser Mini | iCab
iCab Mobile | IceCat | IceDragon | Iceweasel | iDesktop PC Browser | IE Browser Fast | IE Mobile
Indian UC Mini Browser | Inspect Browser | Internet Browser Secure | Internet Explorer | Iridium | Iron | Iron Mobile
Isivioo | IVVI Browser | Japan Browser | Jasmine | JavaFX | Jelly | Jig Browser
Jig Browser Plus | Jio Browser | JioPages | K-meleon | K.Browser | Kapiko | Kazehakase
Keepsafe Browser | Kids Safe Browser | Kindle Browser | Kinza | Kiwi | Kode Browser | Konqueror
KUTO Mini Browser | Kylo | Lagatos Browser | Lark Browser | Lenovo Browser | Lexi Browser | LG Browser
LieBaoFast | Light | Lightning Browser | Lilo | Links | Lolifox | Lovense Browser
LT Browser | LuaKit | Lulumi | Lunascape | Lunascape Lite | Lynket Browser | Lynx
Maelstrom | Mandarin | MAUI WAP Browser | Maxthon | MaxTube Browser | mCent | Me Browser
Meizu Browser | Mercury | MicroB | Microsoft Edge | Midori | Midori Lite | Minimo
Mint Browser | MIUI Browser | Mmx Browser | Mobicip | Mobile Safari | Mobile Silk | Monument Browser
MxNitro | Mypal | Naked Browser | Naked Browser Pro | Navigateur Web | NCSA Mosaic | NetFront
NetFront Life | NetPositive | Netscape | NetSurf | NextWord Browser | NFS Browser | Nokia Browser
Nokia OSS Browser | Nokia Ovi Browser | NOMone VR Browser | Nova Video Downloader Pro | Nox Browser | NTENT Browser | Obigo
OceanHero | Oculus Browser | Odin | Odin Browser | Odyssey Web Browser | Off By One | Office Browser
OH Browser | OH Private Browser | OhHai Browser | OmniWeb | ONE Browser | Open Browser | Open Browser 4U
Open Browser fast 5G | OpenFin | Openwave Mobile Browser | Opera | Opera Crypto | Opera Devices | Opera GX
Opera Mini | Opera Mini iOS | Opera Mobile | Opera Neon | Opera Next | Opera Touch | Oppo Browser
Opus Browser | Orca | Ordissimo | Oregano | Origin In-Game Overlay | Origyn Web Browser | Otter Browser
Pale Moon | Palm Blazer | Palm Pre | Palm WebPro | Palmscape | Peeps dBrowser | Perfect Browser
Phantom Browser | Phantom.me | Phoenix | Phoenix Browser | Pi Browser | PlayFree Browser | Pluma
PocketBook Browser | Polaris | Polarity | PolyBrowser | Polypane | Privacy Explorer Fast Safe | PrivacyWall
PronHub Browser | PSI Secure Browser | Puffin | Puffin Web Browser | Pure Lite Browser | Pure Mini Browser | Qazweb
QQ Browser | QQ Browser Lite | QQ Browser Mini | QtWebEngine | Quark | Quick Browser | QupZilla
Qutebrowser | Qwant Mobile | Rabbit Private Browser | Raise Fast Browser | Realme Browser | Rekonq | Reqwireless WebViewer
RockMelt | Safari | Safari Technology Preview | Safe Exam Browser | Sailfish Browser | SalamWeb | Samsung Browser
Savannah Browser | SavySoda | Secure Browser | Secure Private Browser | Seewo Browser | SEMC-Browser | Seraphic Sraf
Seznam Browser | SFive | Sharkee Browser | Shiira | Sidekick | SilverMob US | SimpleBrowser
SiteKiosk | Sizzy | Skyfire | Sleipnir | Slimjet | Smart Browser | Smart Lenovo Browser
Smart Search & Web Browser | Smooz | Snowshoe | Sogou Explorer | Sogou Mobile Browser | Sony Small Browser | SOTI Surf
Soul Browser | Soundy Browser | SP Browser | Spectre Browser | Splash | Sputnik Browser | Stampy Browser
Stargon | START Internet Browser | Steam In-Game Overlay | Streamy | Sunrise | Super Fast Browser | SuperBird
SuperFast Browser | surf | Surf Browser | Sushi Browser | Sweet Browser | Swiftfox | SX Browser
T-Browser | t-online.de Browser | T+Browser | Tao Browser | TenFourFox | Tenta Browser | Tesla Browser
Tint Browser | Tizen Browser | ToGate | TUC Mini Browser | Tungsten | TV Bro | TweakStyle
U Browser | UBrowser | UC Browser | UC Browser HD | UC Browser Mini | UC Browser Turbo | Ui Browser Mini
Ume Browser | UR Browser | Uzbl | Vast Browser | vBrowser | Vegas Browser | Venus Browser
Via | Viasat Browser | Vision Mobile Browser | Vivaldi | Vivid Browser Mini | vivo Browser | VMware AirWatch
Waterfox | Wave Browser | Wavebox | Wear Internet Browser | Web Browser & Explorer | Web Explorer | WebPositive
WeTab Browser | Whale Browser | Wolvic | wOSBrowser | X Browser Lite | X-VPN | xBrowser
XBrowser Mini | xBrowser Pro Super Fast | Xiino | XNX Browser | Xooloo Internet | xStand | XtremeCast
Xvast | Yaani Browser | YAGI | Yahoo! Japan Browser | Yandex Browser | Yandex Browser Lite | Yo Browser
Yolo Browser | YouCare | Yuzu Browser | Zetakey | Zirco Browser | Zvu

</details>

[[top]](#top)
