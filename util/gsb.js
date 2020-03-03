/*    Copyright 2019-2020 Firewalla INC
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

 'use strict'
var request = require("request")
var urlhash = require("../util/UrlHash.js");
/*
THREAT_ENTRY_TYPE_UNSPECIFIED	Unspecified.
URL	A URL.
EXECUTABLE	An executable program.
IP_RANGE


THREAT_TYPE_UNSPECIFIED	Unknown.
MALWARE	Malware threat type.
SOCIAL_ENGINEERING	Social engineering threat type.
UNWANTED_SOFTWARE	Unwanted software threat type.
POTENTIALLY_HARMFUL_APPLICATION	Potentially harmful application threat type.

PLATFORM_TYPE_UNSPECIFIED	Unknown platform.
WINDOWS	Threat posed to Windows.
LINUX	Threat posed to Linux.
ANDROID	Threat posed to Android.
OSX	Threat posed to OS X.
IOS	Threat posed to iOS.
ANY_PLATFORM	Threat posed to at least one of the defined platforms.
ALL_PLATFORMS	Threat posed to all defined platforms.
CHROME	Threat posed to Chrome.
*/

/*
var b = {
  "client": {
    "clientId":"firewalla",
    "clientVersion": "1.0"
  },
  "threatInfo": {
    "threatTypes":      ["MALWARE","SOCIAL_ENGINEERING","UNWANTED_SOFTWARE","POTENTIALLY_HARMFUL_APPLICATION"],
    "platformTypes":    ["ANY_PLATFORM"],
    "threatEntryTypes": ["URL"],
    "threatEntries": [
      {"url": "http://05p.com/"},
      {"url": "http://amazon.com/"},
      {"url": "http://malware.testing.google.test/testing/malware/"},
      {"url": "http://malware.testing.google.test/"},
      {"url": "http://cdethstfrjhstfrjeadfrds.cx.cc/w.php"},
      {"url": "bluga.com.ar/fran/googledocs/login.php"},
      {"url": "bluga.com.ar/*"},
      {"url":"mirror.os6.org"},
      {"url":"allora-tour.by"},
    ]
  }
}
*/

const key = "";

function hashCheck(hashlist,callback) {
    var reqdata = 
    {
      "client": {
        "clientId":      "firewalla",
        "clientVersion": "1.01"
      },
      "threatInfo": {
        "threatTypes":      ["MALWARE","SOCIAL_ENGINEERING","UNWANTED_SOFTWARE","POTENTIALLY_HARMFUL_APPLICATION"],
        "platformTypes":    ["ANY_PLATFORM"],
        "threatEntryTypes": ["URL"],
        "threatEntries": hashlist
      }
    }
    var options = {
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      method: "POST",
      url: "https://safebrowsing.googleapis.com/v4/fullHashes:find?key="+key,
      json: reqdata
    }
    request(options,(err,httpResponse,body) => {
        if (err) {
           callback(err,null);
        } else {
           callback(err,body);
        }
    });
}


function urlCheck(threatlist,callback) {
    var reqdata = {
      "client": {
        "clientId":"firewalla",
        "clientVersion": "1.0"
      },
      "threatInfo": {
        "threatTypes":      ["MALWARE","SOCIAL_ENGINEERING","UNWANTED_SOFTWARE","POTENTIALLY_HARMFUL_APPLICATION"],
        "platformTypes":    ["ANY_PLATFORM"],
        "threatEntryTypes": ["URL"],
        "threatEntries": threatlist
      }
    }

    var options = {
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      method: "POST",
      url: "https://safebrowsing.googleapis.com/v4/threatMatches:find?key="+key,
      json: reqdata
    }
 
    request(options,(err,httpResponse,body) => {
        if (err) {
           callback(err,null);
        } else {
           callback(err,body);
        }
    });
}

let urls = [
//      {"url": "http://05p.com/"},
//      {"url": "http://amazon.com/"},
//      {"url": "malware.testing.google.test/testing/malware/"},
//        {"url": "http://cdethstfrjhstfrjeadfrds.cx.cc/w.php"},
    //    {"url": "http://bluga.com.ar/fran/googledocs/login.php"},
//        {"url": "bluga.com.ar/fran/googledocs/login.php"},
        {"url":"malware.wicar.org/data/eicar.com"},
//      {"url": "bluga.com.ar/*"},
//      {"url":"mirror.os6.org"},
//      {"url":"allora-tour.by"},
];

let hashes = [];

for (var i in urls) {
   let hash =  urlhash.canonicalizeAndHashExpressions(urls[i].url);
   console.log(hash);
   for (let j in hash) {
       hashes.push({'hash':hash[j][2]});
   }
}

console.log(hashes);

urlCheck(urls,(err,res)=>{
    console.log("URL");
    if (res) {
      console.log(res.matches);
    }
});

hashCheck([{ hash: '6SZItuxx5I3mXFYjyGTgPh0n6i5clEFNHdyLB7uLqpI=' }],(err,res)=> {
  if (res) {
    console.log(res.matches);
  }
});

hashCheck(hashes,(err,res)=>{
    console.log("HASH");
    if (res) {
      console.log(res.matches);
    }
});

module.exports = {
   urlCheck: urlCheck,
   hashCheck: hashCheck
};

