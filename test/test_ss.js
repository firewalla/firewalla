/*    Copyright 2026 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
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

'use strict';

const assert = require('assert');
const ssRouter = require('../api/routes/ss.js');

describe('/ss garbage route', function() {
  const getGarbageHandler = () => {
    const layer = ssRouter.stack.find(
      entry => entry.route && entry.route.path === '/garbage'
    );
    assert(layer, 'GET /garbage route should be registered');
    assert.strictEqual(layer.route.stack.length, 1);
    return layer.route.stack[0].handle;
  };

  const createResponse = () => ({
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    write() {
      throw new Error('response body must not be written for invalid ckSize');
    },
    end() {
      throw new Error('response must not be completed normally for invalid ckSize');
    },
  });

  for (const value of ['Infinity', 'NaN', '1.5', '-1', '101']) {
    it(`rejects invalid ckSize=${value}`, async function() {
      const req = {
        query: {
          ckSize: value,
        },
      };
      const res = createResponse();

      await getGarbageHandler()(req, res);

      assert.strictEqual(res.statusCode, 400);
      assert.deepStrictEqual(res.body, {
        errors: ['Invalid ckSize. Expected an integer from 0 to 100.'],
      });
    });
  }

  it('uses the existing default when ckSize is omitted', async function() {
    const handler = getGarbageHandler();
    const req = {query: {}};
    const writes = [];
    let resolveResponse;
    let rejectResponse;
    const responseComplete = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const res = {
      status() {
        return this;
      },
      json() {},
      write(chunk) {
        try {
          writes.push(chunk);
        } catch (error) {
          rejectResponse(error);
        }
      },
      end() {
        resolveResponse();
      },
    };

    await handler(req, res);
    await responseComplete;
    assert.strictEqual(writes.length, 100);
  });
});
