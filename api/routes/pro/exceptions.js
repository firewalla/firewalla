'use strict'

const endpoint = '/' + require("path").basename(__filename, '.js');

module.exports = function(router, netbotHandler) {
    router.get(endpoint, (req, res) => {
      netbotHandler(req._gid, 'get', {item: 'exceptions'}).then(resp => res.json(resp.data.exceptions));
    });
}
