'use strict'

const endpoint = '/' + require("path").basename(__filename, '.js');

module.exports = function(router, netbotHandler) {
    router.post(endpoint, (req, res) => {
      netbotHandler(req._id, req.body, res);
    });
}
