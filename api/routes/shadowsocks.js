var express = require('express');
const passport = require('passport')
var router = express.Router();

var shadowsocks = require('../../extension/shadowsocks/shadowsocks.js');
var ss = new shadowsocks('info');

/* shadowsocks api */
router.get('/config', 
    passport.authenticate('bearer', { session: false }),
    function(req, res, next) {
        res.json(
            ss.readConfig()
        );
    });

router.post('/config/renew', 
    passport.authenticate('bearer', { session: false }),
    function(req, res, next) {
        ss.refreshConfig();
        res.status(200).send('');
    });

router.post('/nat/:action', 
    passport.authenticate('bearer', { session: false }),
    function(req, res, next) {
        res.send(req.params.action);
    });

router.post('/:action', 
    passport.authenticate('bearer', { session: false }),
    function(req, res, next) {
        var action = req.params.action;
        if (action === "start") {
            ss.start(function(err, result) {
                if(err) {
                    res.json(err);
                } else {
                    res.json(result);
                }
            });
        } else if (action === "stop") {
            ss.stop(function(err, result) {
                if(err) {
                    res.json(err);
                } else {
                    res.json(result);
                }
            });
        }
    });

module.exports = router;
