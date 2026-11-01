'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { describe, it } = require('mocha');

const mainSource = fs.readFileSync(
    path.join(__dirname, '../main.js'),
    'utf8',
);

function createAdapter(snapshot) {
    class MockAdapter extends EventEmitter {
        constructor() {
            super();
            this.namespace = 'blink.0';
        }
    }

    const mockRequire = name => {
        if (name === '@iobroker/adapter-core') {
            return { Adapter: MockAdapter };
        }
        if (name === './lib/blink-api') {
            return { snapshot };
        }
        if (name === './lib/mjpeg-server') {
            return { MjpegServer: class {} };
        }
        return require(name);
    };

    const mod = { exports: {} };

    vm.runInNewContext(
        mainSource,
        {
            module: mod,
            require: mockRequire,
            Buffer,
        },
        {
            filename: 'main.js',
            timeout: 3000,
        },
    );

    const adapter = mod.exports();

    const logs = {
        info: [],
        debug: [],
        warn: [],
    };

    adapter.log = {
        info: msg => logs.info.push(msg),
        debug: msg => logs.debug.push(msg),
        warn: msg => logs.warn.push(msg),
    };

    adapter.session = {};
    adapter.cfg = {
        snapshotDir: '/tmp',
        cleanupOldSnapshots: false,
    };

    adapter.camerasById.set('101', {
        id: '101',
        name: 'Front',
        network_id: 'net-1',
    });

    adapter.setLiveStates = async () => {};

    return { adapter, logs };
}

function busyError() {
    return new Error(
        'HTTP 409: {"message":"System is busy"}',
    );
}

describe('Live snapshot HTTP 409 logging', () => {
    it('limits INFO messages to once per ten minutes', async () => {
        const { adapter, logs } = createAdapter(
            async () => {
                throw busyError();
            },
        );

        await adapter.updateLiveSnapshots();

        assert.equal(logs.info.length, 1);
        assert.equal(logs.debug.length, 0);

        await adapter.updateLiveSnapshots();

        assert.equal(logs.info.length, 1);
        assert.equal(logs.debug.length, 1);

        // Simulieren, dass die zehn Minuten vergangen sind.
        adapter.lastLiveSnapshotBusyInfoByDevId.set(
            '101',
            Date.now() -
                adapter.liveSnapshotBusyInfoIntervalMs -
                1000,
        );

        await adapter.updateLiveSnapshots();

        assert.equal(logs.info.length, 2);
        assert.equal(logs.debug.length, 1);
        assert.equal(logs.warn.length, 0);
        assert.equal(adapter.liveInProgress, false);
    });

    it('resets INFO suppression after a successful snapshot', async () => {
        let calls = 0;

        const { adapter, logs } = createAdapter(
            async () => {
                calls++;

                // Zweiter Aufruf erfolgreich.
                if (calls === 2) {
                    return;
                }

                throw busyError();
            },
        );

        await adapter.updateLiveSnapshots();

        assert.equal(logs.info.length, 1);

        await adapter.updateLiveSnapshots();

        assert.equal(
            adapter.lastLiveSnapshotBusyInfoByDevId.has('101'),
            false,
        );

        await adapter.updateLiveSnapshots();

        assert.equal(calls, 3);
        assert.equal(logs.info.length, 2);
        assert.equal(logs.debug.length, 0);
        assert.equal(logs.warn.length, 0);
        assert.equal(adapter.liveInProgress, false);
    });
});
