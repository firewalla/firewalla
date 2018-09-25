'use strict'

const endpoint = '/' + require("path").basename(__filename, '.js');

module.exports = function(router, netbotHandler) {
    router.get(endpoint, (req, res) => {
      netbotHandler(req._gid, 'get', 
      {
        item: 'exceptions'
      }).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });

    router.post(endpoint, (req, res) => {
      netbotHandler(req._gid, 'cmd', 
      {
        item: 'exception:create',
        value: req.body
      }).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });

    router.put(endpoint + '/:eid', (req, res) => {
      let id = {eid: req.params.eid}
      netbotHandler(req._gid, 'cmd', 
      {
        item: 'exception:update',
        value: {...req.body, ...id}
      }).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });

    router.delete(endpoint + '/:eid', (req, res) => {
      netbotHandler(req._gid, 'cmd', 
      {
        item: 'exception:delete',
        value: {exceptionID: req.params.eid}
      }).then(resp => res.status(resp.code).json(resp.data || resp.message));
    });
}
