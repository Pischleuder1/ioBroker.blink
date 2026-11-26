'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { describe, it } = require('mocha');

const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

describe('Blink history concurrency protection', () => {
	it('prevents concurrent syncs of the same camera', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-history-concurrency-'));

		const camera = {
			id: 'camera-1',
			name: 'Camera One',
			network_id: 'network-1',
		};

		const states = new Map();
		let downloads = 0;
		/** @type {(() => void) | undefined} */
		let releaseDownload;
		let signalStarted;

		const started = new Promise(resolve => {
			signalStarted = resolve;
		});

		/** @type {Promise<void>} */
		const downloadGate = new Promise(resolve => {
			releaseDownload = resolve;
		});

		const api = {
			getHistoryClips: async () => ({
				source: 'cloud',
				clips: [
					{
						id: 'clip-1',
						created_at: '2026-11-26T18:00:00Z',
						_cloudUrl: 'https://example.invalid/clip.mp4',
					},
				],
			}),

			downloadCloudClip: async (_session, clip, destination) => {
				downloads++;
				signalStarted();
				await downloadGate;
				fs.writeFileSync(destination, `video-${clip.id}`);
			},
		};

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

		const mod = { exports: /** @type {any} */ ({}) };

		try {
			vm.runInNewContext(
				mainSource,
				{ module: mod, require: mockRequire, Buffer },
				{ filename: 'main.js', timeout: 3000 },
			);

			const adapter = mod.exports();

			adapter.session = {};
			adapter.cfg = { snapshotDir: dir };
			adapter.findSyncIdForNetwork = () => null;

			adapter.log = {
				debug() {},
				info() {},
				warn() {},
				error() {},
			};

			adapter.getStateAsync = async key => ({
				val: states.get(key) ?? '',
			});

			adapter.setStateAsync = async (key, value) => {
				states.set(key, value);
			};

			// Ersten Download starten und anhalten.
			const first = adapter.syncCameraHistory(camera, camera.id);

			await started;

			assert.equal(downloads, 1);
			assert.equal(adapter.historySyncInProgressByDevId.has(camera.id), true);

			// Zweiter Aufruf derselben Kamera muss übersprungen werden.
			await adapter.syncCameraHistory(camera, camera.id);

			assert.equal(downloads, 1);

			// Ersten Download abschließen.
			releaseDownload?.();
			await first;

			assert.equal(adapter.historySyncInProgressByDevId.has(camera.id), false);

			const slot = path.join(dir, `${camera.id}_history_0.mp4`);

			assert.equal(fs.readFileSync(slot, 'utf8'), 'video-clip-1');

			assert.equal(states.get(`cameras.${camera.id}.video.history.0.id`), 'clip-1');
		} finally {
			if (releaseDownload) {
				releaseDownload?.();
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
