/*    Copyright 2018-2019 Firewalla INC
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const express = require('express');
const path = require('path');
const router = express.Router();
const bodyParser = require('body-parser')

let cache;

// Cap concurrent /garbage downloads. The endpoint is unauthenticated, and one
// client can open many connections; each concurrent response buffers, so the
// aggregate has to be bounded, not just each response. The limit sits just above
// the shipped speed-test client, which opens up to 6 parallel streams, one
// connection each (xhr_dlMultistream in api/public/ss/speedtest_worker.js).
const MAX_GARBAGE = 8;
let activeGarbage = 0;

router.get('/empty', function (req, res) {
    res.sendStatus(200);
});

router.post('/empty', function (req, res) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.set("Cache-Control", "post-check=0, pre-check=0");
    res.set("Pragma", "no-cache");
    res.sendStatus(200);
});

router.get('/garbage', function (req, res) {
//    res.set('Content-Description', 'File Transfer');
//    res.set('Content-Type', 'application/octet-stream');
//    res.set('Content-Disposition', 'attachment; filename=random.dat');
//    res.set('Content-Transfer-Encoding', 'binary');
//    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
//    res.set('Cache-Control', 'post-check=0, pre-check=0', false);
//    res.set('Pragma', 'no-cache');
    // each chunk is 1MiB and this endpoint is unauthenticated, keep the response bounded
    const ckSize = Number(req.query.ckSize);
    const requestedSize = Number.isInteger(ckSize) && ckSize > 0 ? Math.min(ckSize, 1024) : 100;

    // Hold a concurrency slot, and free it from the connection socket, not the
    // response. A /garbage response pipelined behind another response on the same
    // connection has no socket of its own yet and emits no 'finish'/'close' until it
    // reaches the head of the queue; a request whose client disconnected during an
    // earlier async middleware (the app mounts express.static ahead of this router)
    // has already emitted them before this handler runs. The connection socket's
    // 'close' fires exactly once when the connection ends, in both Node versions the
    // box runs (12 or 24), so the slot is freed from there. Refuse a request whose
    // connection is already gone: it would take a slot no later event could return.
    const conn = req.socket;
    if (!conn || conn.destroyed) {
        return;
    }
    if (activeGarbage >= MAX_GARBAGE) {
        res.status(503).end();
        return;
    }
    activeGarbage++;
    // one 'close' listener per in-flight response on this connection, cap-bounded;
    // raise the ceiling so a pipelined burst does not trip the EventEmitter warning.
    if (conn.getMaxListeners() < MAX_GARBAGE + 5)
        conn.setMaxListeners(MAX_GARBAGE + 5);
    let done = false;
    const release = () => {
        if (done)
            return;
        done = true;
        activeGarbage--;
        conn.removeListener('close', release);
    };
    res.on('finish', release);
    res.on('close', release);
    conn.on('close', release);

    // every chunk is the same buffer. this endpoint is unauthenticated, so the write
    // loop must bound both the event loop and memory under abuse, including an unread
    // client that pipelines many requests on one connection. Do not rely on stream
    // backpressure events: Node's 'drain'/pipe resume fire synchronously under
    // pipelining (and differ by Node version -- the box runs Node 12 or Node 24), so
    // they can drive a whole response into memory in one turn. Instead pace by hand
    // on two version-stable primitives: write at most BATCH chunks per event-loop
    // turn (setImmediate yields, so no request blocks FireApi), and before each turn
    // pause while the socket already holds LIMIT bytes (a client that stops reading
    // never drains, so the loop parks via setTimeout instead of queuing the rest).
    // The pump stops as soon as release runs (connection closed or response done).
    const BATCH = 8;
    const LIMIT = 4 * 1048576;
    const send = () => {
        let i = 0;
        const pump = () => {
            if (done)
                return;
            const sock = res.socket;
            if (!sock) {
                // not yet joined to its socket (pipelined behind another response on
                // this connection); wait rather than buffer the payload in memory.
                setTimeout(pump, 20);
                return;
            }
            if (sock.writableLength >= LIMIT) {
                setTimeout(pump, 20);
                return;
            }
            let n = 0;
            while (i < requestedSize && !done) {
                i++;
                res.write(cache);
                if (++n >= BATCH) {
                    setImmediate(pump);
                    return;
                }
            }
            if (!done)
                res.end();
        };
        pump();
    }

    if (cache) {
        send();
    } else {
        require('crypto').randomBytes(1048576, (error, bytes) => {
            cache = bytes;
            send();
        });
    }

});

module.exports = router;
