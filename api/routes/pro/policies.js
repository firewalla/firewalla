'use strict'

const endpoint = __filename;

export default function(router) {
    router.get(endpoint, (req, res) => res.send('policies'));
}
