'use strict'

function add_acl(ip) {
  var http = require("http");

  var options = {
    "method": "POST",
    "hostname": "localhost",
    "port": "8833",
    "path": "/v1/encipher/message/cleartext/5ce76839-a01d-4db5-940e-bc5596b5488d",
    "headers": {
      "authorization": "Bearer agoodtoken",
      "content-type": "application/json",
      "cache-control": "no-cache",
      "postman-token": "5f9da961-4131-7d20-f49a-42e95ba09c92"
    }
  };

  var req = http.request(options, function (res) {
    var chunks = [];

    res.on("data", function (chunk) {
      chunks.push(chunk);
    });

    res.on("end", function () {
      var body = Buffer.concat(chunks);
      console.log(body.toString());
    });
  });

  req.write(JSON.stringify({ message: 
                             { mtype: 'msg',
                               obj: 
                               { mtype: 'set',
                                 data: 
                                 { value: 
                                   { acl: 
                                     { dhname: 'ea.com',
                                       ref: '0.0.0.0',
                                       shname: ip,
                                       src: ip,
                                       ts: 1487011774.075818,
                                       org: 'Electronic Arts\\',
                                       dst: '159.153.186.70',
                                       detailedInfo: 'Host iAnnie likely playing games or visiting gaming sites from ea.com for 89 min',
                                       refclass: 'alarm',
                                       state: true } },
                                   item: 'policy' },
                                 id: 'D67C7131-A085-4A81-ADFE-EF5C90946318',
                                 type: 'jsonmsg',
                                 target: '0.0.0.0' },
                               msg: '',
                               type: 'jsondata',
                               from: 'Unamed' },
                             mtype: 'msg' }));
  req.end();
}

let ip_prefix = "172.17.0.";

if(process.argv[2]) {
    for(let i = 2; i < process.argv.length; i++) {
        add_acl(ip_prefix + process.argv[i]);
    }
} else {
    for(let i = 0; i<2; i++) {
      let ip = ip_prefix + (i + 50);
      console.log("blocking ip " + ip);
      add_acl(ip);
    }
}
