'use strict';

const express = require('express');
const app = express();
const port = 80;
const httpsPort = 443;
const path = require('path');
const certPath = 'extension/httpd';
const fs = require('fs');
const https = require('https');

const httpsOptions = {
    key: fs.readFileSync(path.join(certPath, "domain.key")),
    cert: fs.readFileSync(path.join(certPath, "domain.crt"))
};

app.use('*', (req, res) => {
  let txt = `Ads Blocked by Firewalla: ${req.ip} => ${req.method}: ${req.hostname}${req.originalUrl}`;
  res.send(txt);
  console.log(txt);
});

app.listen(port, () => console.log(`Httpd istening on port ${port}!`));

https.createServer(httpsOptions, app).listen(httpsPort, () => console.log(`Httpd istening on port ${httpsPort}!`));
