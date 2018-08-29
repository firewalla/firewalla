'use strict'

const endpoint = '/' + require("path").basename(__filename, '.js');

module.exports = function(router) {
    router.get(endpoint, (req, res) => res.send('policies for ' + req._gid));
}
