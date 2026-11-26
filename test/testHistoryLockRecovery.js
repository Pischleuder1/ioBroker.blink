'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { describe, it } = require('mocha');

const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function createTestAdapter(api, dir) {
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

	vm.runInNewContext(
		mainSource,
		{ module: mod, require: mockRequire, Buffer },
		{ filename: 'main.js', timeout: 3000 },
	);

	const adapter = mod.exports();
	const states = new Map();

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

	return { adapter, states };
}

describe('Blink history lock recovery', () => {
	it('allows different cameras to sync concurrently', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-history-parallel-'));

		const cameras = [
			{ id: 'camera-A', name: 'Camera A', network_id: 'net-A' },
			{ id: 'camera-B', name: 'Camera B', network_id: 'net-B' },
		];

		const started = new Set();
		const release = new Map();
		const downloads = [];

		const api = {
			getHistoryClips: async (_session, networkId) => ({
				source: 'cloud',
				clips: [
					{
						id: `clip-${networkId}`,
						created_at: '2026-11-26T18:00:00Z',
						_cloudUrl: 'https://example.invalid/video.mp4',
					},
				],
			}),

			downloadCloudClip: async (_session, clip, destination) => {
				downloads.push(clip.id);
				started.add(clip.id);

				await new Promise(resolve => {
					release.set(clip.id, resolve);
				});

				fs.writeFileSync(destination, `video-${clip.id}`);
			},
		};

		const { adapter } = createTestAdapter(api, dir);

		try {
			const first = adapter.syncCameraHistory(cameras[0], cameras[0].id);

			const second = adapter.syncCameraHistory(cameras[1], cameras[1].id);

			// Beide Downloads müssen unabhängig gestartet werden können.
			for (let i = 0; i < 20 && started.size < 2; i++) {
				await new Promise(resolve => setImmediate(resolve));
			}

			assert.equal(started.size, 2);
			assert.equal(adapter.historySyncInProgressByDevId.size, 2);

			for (const resolve of release.values()) {
				resolve();
			}

			await Promise.all([first, second]);

			assert.equal(adapter.historySyncInProgressByDevId.size, 0);

			for (const camera of cameras) {
				const file = path.join(dir, `${camera.id}_history_0.mp4`);
				assert.equal(fs.existsSync(file), true);
			}

			assert.equal(downloads.length, 2);
		} finally {
			for (const resolve of release.values()) {
				resolve();
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('releases the camera lock after an exception', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-history-lock-error-'));

		const camera = {
			id: 'camera-error',
			name: 'Error Camera',
			network_id: 'network-error',
		};

		let requests = 0;

		const api = {
			getHistoryClips: async () => {
				requests++;

				if (requests === 1) {
					throw new Error('Simulated history API failure');
				}

				return { source: 'cloud', clips: [] };
			},
		};

		const { adapter } = createTestAdapter(api, dir);

		try {
			await assert.rejects(adapter.syncCameraHistory(camera, camera.id), /Simulated history API failure/);

			assert.equal(adapter.historySyncInProgressByDevId.has(camera.id), false);

			await adapter.syncCameraHistory(camera, camera.id);

			assert.equal(requests, 2);
			assert.equal(adapter.historySyncInProgressByDevId.has(camera.id), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('blocks only the camera with a leftover backup', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-history-backup-guard-'));

		const cameraA = {
			id: 'camera-A',
			name: 'Camera A',
			network_id: 'network-A',
		};

		const cameraB = {
			id: 'camera-B',
			name: 'Camera B',
			network_id: 'network-B',
		};

		const backupDir = path.join(dir, '.blink-history-backup-camera-A-test');

		fs.mkdirSync(backupDir);

		// Simulierte Sicherungsdatei darf nicht verändert werden.
		const backupFile = path.join(backupDir, '0.mp4');
		fs.writeFileSync(backupFile, 'original-backup');

		const downloads = [];
		const warnings = [];

		const api = {
			getHistoryClips: async (_session, networkId) => ({
				source: 'cloud',
				clips: [
					{
						id: `clip-${networkId}`,
						created_at: '2026-11-26T18:00:00Z',
						_cloudUrl: 'https://example.invalid/video.mp4',
					},
				],
			}),

			downloadCloudClip: async (_session, clip, destination) => {
				downloads.push(clip.id);
				fs.writeFileSync(destination, `video-${clip.id}`);
			},
		};

		const { adapter, states } = createTestAdapter(api, dir);

		adapter.log.error = message => {
			warnings.push(message);
		};

		try {
			// Kamera A muss wegen des Backups gesperrt bleiben.
			await adapter.syncCameraHistory(cameraA, cameraA.id);

			assert.equal(downloads.length, 0);
			assert.equal(fs.readFileSync(backupFile, 'utf8'), 'original-backup');

			assert.equal(
				warnings.some(message => message.includes('History backup recovery required')),
				true,
			);

			assert.equal(adapter.historySyncInProgressByDevId.size, 0);

			// Kamera B darf unabhängig weiterarbeiten.
			await adapter.syncCameraHistory(cameraB, cameraB.id);

			assert.deepEqual(downloads, ['clip-network-B']);

			assert.equal(states.get('cameras.camera-B.video.history.0.id'), 'clip-network-B');

			// Nach manueller Freigabe im Test darf Kamera A laufen.
			fs.rmSync(backupDir, {
				recursive: true,
				force: true,
			});

			await adapter.syncCameraHistory(cameraA, cameraA.id);

			assert.deepEqual(downloads, ['clip-network-B', 'clip-network-A']);

			assert.equal(states.get('cameras.camera-A.video.history.0.id'), 'clip-network-A');

			assert.equal(adapter.historySyncInProgressByDevId.size, 0);
		} finally {
			fs.rmSync(dir, {
				recursive: true,
				force: true,
			});
		}
	});

	it('blocks incomplete and invalid backup manifests', async () => {
		const cases = [
			{
				name: 'missing-manifest',
				setup() {},
			},
			{
				name: 'invalid-json',
				setup(dir) {
					fs.writeFileSync(path.join(dir, 'manifest.json'), '{ invalid json');
				},
			},
			{
				name: 'missing-backed-up-file',
				setup(dir) {
					fs.writeFileSync(
						path.join(dir, 'manifest.json'),
						JSON.stringify({
							version: 1,
							cameraId: 'camera-recovery',
							historySize: 10,
							originalFiles: [true, false, false, false, false, false, false, false, false, false],
							previousStates: [],
						}),
					);
				},
			},
		];

		for (const scenario of cases) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-history-crash-'));

			const camera = {
				id: 'camera-recovery',
				name: 'Recovery Camera',
				network_id: 'network-recovery',
			};

			const backupDir = path.join(dir, '.blink-history-backup-camera-recovery-crashed');

			fs.mkdirSync(backupDir);
			scenario.setup(backupDir);

			const originalFile = path.join(dir, 'camera-recovery_history_0.mp4');

			fs.writeFileSync(originalFile, 'original-video');

			let downloads = 0;
			const errors = [];

			const api = {
				getHistoryClips: async () => ({
					source: 'cloud',
					clips: [
						{
							id: 'new-clip',
							created_at: '2026-11-26T18:00:00Z',
							_cloudUrl: 'https://example.invalid/video.mp4',
						},
					],
				}),

				downloadCloudClip: async () => {
					downloads++;
				},
			};

			const { adapter, states } = createTestAdapter(api, dir);

			adapter.log.error = message => {
				errors.push(message);
			};

			try {
				await adapter.syncCameraHistory(camera, camera.id);

				assert.equal(downloads, 0, `${scenario.name}: unexpected download`);

				assert.equal(fs.readFileSync(originalFile, 'utf8'), 'original-video');

				assert.equal(states.size, 0);

				assert.equal(fs.existsSync(backupDir), true);

				assert.equal(
					errors.some(message => message.includes('History backup recovery required')),
					true,
					`${scenario.name}: expected recovery warning`,
				);

				assert.equal(adapter.historySyncInProgressByDevId.size, 0);
			} finally {
				fs.rmSync(dir, {
					recursive: true,
					force: true,
				});
			}
		}
	});
});
