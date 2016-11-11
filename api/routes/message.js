var express = require('express');
var router = express.Router();

router.get('/', function(req, res, next) {
    console.log(require('util').inspect(req));
    
    res.send('hello world');
});

module.exports = router;
