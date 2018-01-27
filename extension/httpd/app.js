const express = require('express');
const app = express();
const port = 80;

app.use('/*', (req, res) => {
  res.send('Ads Blocked by Firewalla');
});

app.listen(port, () => console.log(`Httpd istening on port ${port}!`))