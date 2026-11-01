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

function createAdapter(api) {
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
            return api;
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

    adapter.session = {};
    adapter.cfg = {
        snapshotDir: '/tmp',
    };
    adapter.log = {
        debug() {},
        info() {},
        warn() {},
    };

    adapter.findSyncIdForNetwork = () => 'sync-7';

    return adapter;
}

describe('Local Storage manifest cache regression', () => {
    const cameras = [
        { id: '101', name: 'Front', network_id: 'net-1' },
        { id: '102', name: 'Garden', network_id: 'net-1' },
    ];

    it('shares one manifest request across cameras and history', async () => {
        let manifestRequests = 0;
        const historyOptions = [];
        const timestamp = '2026-10-30T15:29:24Z';

        const api = {
            getLocalStorageClips: async () => {
                manifestRequests++;
                return {
                    manifestId: 'manifest-7',
                    clips: [],
                };
            },
            getLatestVideoInfo: async () => ({
                id: 'clip-1',
                created_at: timestamp,
            }),
            getLatestVideoSummary: async () => ({
                id: 'clip-1',
                created_at: timestamp,
            }),
            getHistoryClips: async (...args) => {
                historyOptions.push(args[4]);
                return { clips: [], source: 'cloud' };
            },
        };

        const adapter = createAdapter(api);

        adapter.isUsableFile = () => true;
        adapter.updateDetectionStates = async () => {};
        adapter.setStateAsync = async () => {};

        adapter.getStateAsync = async id => {
            if (id.endsWith('.video.snapshot_url')) {
                return { val: 'already-generated' };
            }
            if (id.endsWith('.video.timestamp')) {
                return { val: timestamp };
            }
            if (id.endsWith('.video.id')) {
                return { val: 'clip-1' };
            }
            if (id.endsWith('.video.file')) {
                return { val: '/tmp/existing-clip.mp4' };
            }
            return null;
        };

        await adapter.syncLatestCloudVideos(cameras);

        assert.equal(manifestRequests, 1);
        assert.equal(historyOptions.length, 2);

        for (const opts of historyOptions) {
            assert.equal(opts.syncId, 'sync-7');
            assert.equal(
                opts.localManifest.manifestId,
                'manifest-7',
            );
        }

        assert.equal(adapter.videoSyncInProgress, false);
    });

    it('does not request a second manifest after failure', async () => {
        let manifestRequests = 0;
        const historyOptions = [];

        const api = {
            getLocalStorageClips: async () => {
                manifestRequests++;
                throw new Error('Local storage unavailable');
            },
            getHistoryClips: async (...args) => {
                historyOptions.push(args[4]);
                return { clips: [], source: 'none' };
            },
        };

        const adapter = createAdapter(api);
        const sharedCache = new Map();

        for (const cam of cameras) {
            await adapter.syncCameraHistory(
                cam,
                cam.id,
                null,
                sharedCache,
            );
        }

        assert.equal(manifestRequests, 1);
        assert.equal(historyOptions.length, 2);
        assert.equal(sharedCache.has('sync-7'), true);

        for (const opts of historyOptions) {
            assert.equal(opts.syncId, null);
            assert.equal(opts.localManifest, null);
        }
    });
});
