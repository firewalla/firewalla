'use strict'

let log = require('../../../net2/logger')(__filename);

const endpoint = '/' + require("path").basename(__filename, '.js');

module.exports = function(router, netbotHandler) {
    router.post(endpoint, (req, res) => {
      log.info('Handling msg to', req._gid, 'with body:', req.body)
      netbotHandler(req._gid, req.body.mtype, req.body.data).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });
}
