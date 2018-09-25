'use strict'

const endpoint = '/' + require("path").basename(__filename, '.js');

module.exports = function(router, netbotHandler) {
    router.get(endpoint, (req, res) => {
        netbotHandler(req._gid, 'get', 
        {
            item: 'hosts'
        }).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });
}
