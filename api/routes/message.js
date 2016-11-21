var express = require('express');
var router = express.Router();
const passport = require('passport')


router.get('/', 
  passport.authenticate('bearer', { session: false }),
  function(req, res, next) {
    console.log(require('util').inspect(req));  
    res.send('hello world');
});

module.exports = router;
