'use strict'

const endpoint = '/' + require("path").basename(__filename, '.js');

module.exports = function(router, netbotHandler) {
    router.get(endpoint, (req, res) => {
        netbotHandler(req._gid, 'get', 
        {
            item: 'policies'
        }).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });

    router.post(endpoint, (req, res) => {
        netbotHandler(req._gid, 'cmd', 
        {
            item: 'policy:create',
            value: req.body
        }).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });

    router.put(endpoint + '/:pid', (req, res) => {
        let id = {pid: req.params.pid}
        netbotHandler(req._gid, 'cmd', 
        {
            item: 'policy:update',
            value: {...req.body, ...id}
        }).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });

    router.delete(endpoint + '/:pid', (req, res) => {
        netbotHandler(req._gid, 'cmd', 
        {
            item: 'policy:delete',
            value: {policyID: req.params.pid}
        }).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });
}
