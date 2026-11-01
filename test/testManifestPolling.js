'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('mocha');

const source = fs.readFileSync(
    path.join(__dirname, '../lib/blink-api.js'),
    'utf8',
);

const start = source.indexOf(
    'async function _pollUntilReady(',
);
const end = source.indexOf('\n/**', start);

assert.ok(start >= 0 && end > start);

function createPollingFixture() {
    let clock = 0;
    const delays = [];

    class FakeDate extends Date {
        static now() {
            return clock;
        }
    }

    const poll = vm.runInNewContext(
        `${source.slice(start, end)}\n_pollUntilReady`,
        {
            Date: FakeDate,
            delay: async ms => {
                delays.push(ms);
                clock += ms;
            },
            dbg: () => {},
        },
    );

    return { poll, delays };
}

describe('Local Storage HTTP 409 polling', () => {
    it('continues polling for manifest code 2113', async () => {
        const { poll, delays } = createPollingFixture();
        let attempts = 0;

        const result = await poll(async () => {
            attempts++;

            if (attempts <= 2) {
                const err = new Error(
                    'HTTP 409: {"code":2113,"message":"Manifest command is in process"}',
                );
                err.statusCode = 409;
                throw err;
            }

            return { manifest_id: 'manifest-7' };
        });

        assert.equal(result.manifest_id, 'manifest-7');
        assert.equal(attempts, 3);
        assert.deepEqual(delays, [5000, 5000]);
    });

    it('immediately propagates System is busy', async () => {
        const { poll, delays } = createPollingFixture();
        let attempts = 0;

        const busy = new Error(
            'HTTP 409: {"message":"System is busy"}',
        );
        busy.statusCode = 409;

        await assert.rejects(
            poll(async () => {
                attempts++;
                throw busy;
            }),
            err => err === busy,
        );

        assert.equal(attempts, 1);
        assert.deepEqual(delays, []);
    });

    it('does not retry unrelated HTTP 409 errors', async () => {
        const { poll, delays } = createPollingFixture();
        let attempts = 0;

        const conflict = new Error('HTTP 409: Conflict');
        conflict.statusCode = 409;

        await assert.rejects(
            poll(async () => {
                attempts++;
                throw conflict;
            }),
            err => err === conflict,
        );

        assert.equal(attempts, 1);
        assert.deepEqual(delays, []);
    });
});
