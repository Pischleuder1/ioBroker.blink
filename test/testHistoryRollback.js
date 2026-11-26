'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { describe, it } = require('mocha');

const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

async function runScenario(failRename, failState = false, failManifestWrite = false) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-history-test-'));

	const devId = 'camera-test';
	const camera = {
		id: devId,
		name: 'Test Camera',
		network_id: 'network-test',
	};

	const states = new Map();
	const warnings = [];
	let stateWrites = 0;
	let renameAttempts = 0;
	/** @type {any} */
	let manifestAtCommit = null;

	const slot = i => path.join(dir, `${devId}_history_${i}.mp4`);
	const temp = i => path.join(dir, `.${devId}_history_${i}.tmp.mp4`);
	const idState = i => `cameras.${devId}.video.history.${i}.id`;

	fs.writeFileSync(slot(0), 'original-video-0');
	fs.writeFileSync(slot(1), 'original-video-1');

	states.set(idState(0), 'old-0');
	states.set(idState(1), 'old-1');

	const clips = [0, 1].map(i => ({
		id: `new-${i}`,
		created_at: '2026-11-26T18:00:00Z',
		_cloudUrl: `https://example.invalid/${i}`,
	}));

	const api = {
		getHistoryClips: async () => ({
			clips,
			source: 'cloud',
		}),
		downloadCloudClip: async (_session, clip, destination) => {
			fs.writeFileSync(destination, `new-video-${clip.id}`);
		},
	};

	const mockFs = new Proxy(fs, {
		get(target, property) {
			if (property === 'writeFileSync' && failManifestWrite) {
				return (destination, ...args) => {
					if (typeof destination === 'number') {
						const error = /** @type {NodeJS.ErrnoException} */ (
							new Error('Simulated manifest write failure')
						);
						error.code = 'EIO';
						throw error;
					}
					return Reflect.apply(fs.writeFileSync, fs, [destination, ...args]);
				};
			}

			if (property === 'renameSync') {
				return (from, to) => {
					// Backup vor dem ersten Austausch einer MP4 prüfen.
					if (from.endsWith('.tmp.mp4') && to.endsWith('_history_0.mp4')) {
						const backupDirs = fs
							.readdirSync(dir)
							.filter(name => name.startsWith('.blink-history-backup-'));

						assert.equal(backupDirs.length, 1);

						const backupDir = path.join(dir, backupDirs[0]);
						const manifestPath = path.join(backupDir, 'manifest.json');

						assert.equal(fs.existsSync(manifestPath), true);
						assert.equal(fs.existsSync(path.join(backupDir, 'manifest.json.tmp')), false);

						manifestAtCommit = {
							manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
							backup0: fs.readFileSync(path.join(backupDir, '0.mp4'), 'utf8'),
							backup1: fs.readFileSync(path.join(backupDir, '1.mp4'), 'utf8'),
							live0: fs.readFileSync(slot(0), 'utf8'),
							live1: fs.readFileSync(slot(1), 'utf8'),
						};
					}

					if (from.endsWith('.tmp.mp4') && to.endsWith('_history_1.mp4')) {
						renameAttempts++;
						if (failRename) {
							const error = /** @type {NodeJS.ErrnoException} */ (new Error('Simulated rename failure'));
							error.code = 'EACCES';
							throw error;
						}
					}
					return fs.renameSync(from, to);
				};
			}
			return Reflect.get(target, property);
		},
	});

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
		if (name === 'node:fs' || name === 'fs') {
			return mockFs;
		}
		return require(name);
	};

	const mod = { exports: /** @type {any} */ ({}) };

	try {
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
		adapter.cfg = { snapshotDir: dir };
		adapter.findSyncIdForNetwork = () => null;
		adapter.log = {
			debug() {},
			info() {},
			warn(message) {
				warnings.push(message);
			},
			error(message) {
				warnings.push(message);
			},
		};

		adapter.getStateAsync = async key => ({
			val: states.get(key) || '',
		});

		adapter.setStateAsync = async (key, value) => {
			if (failState && key === idState(1)) {
				throw new Error('Simulated state write failure');
			}
			stateWrites++;
			states.set(key, value);
		};

		let syncError = null;
		try {
			await adapter.syncCameraHistory(camera, devId);
		} catch (error) {
			syncError = error;
		}

		return {
			syncError,
			lockReleased: !adapter.historySyncInProgressByDevId.has(devId),
			files: [fs.readFileSync(slot(0), 'utf8'), fs.readFileSync(slot(1), 'utf8')],
			ids: [states.get(idState(0)), states.get(idState(1))],
			stateWrites,
			renameAttempts,
			remainingTemp: [0, 1].filter(i => fs.existsSync(temp(i))),
			backupDirectories: fs.readdirSync(dir).filter(name => name.startsWith('.blink-history-backup-')),
			manifestAtCommit,
			warnings,
		};
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

async function runCorruptCloudScenario() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-corrupt-test-'));

	let attempts = 0;
	const devId = 'corrupt-camera';
	const camera = {
		id: devId,
		name: 'Corrupt Camera',
		network_id: 'network-corrupt',
	};

	const api = {
		getHistoryClips: async () => ({
			source: 'cloud',
			clips: [
				{
					id: 'corrupt-723',
					created_at: '2026-11-26T18:00:00Z',
					_cloudUrl: 'https://example.invalid/corrupt.mp4',
				},
			],
		}),
		downloadCloudClip: async () => {
			attempts++;
			const error = /** @type {Error & {statusCode?: number}} */ (
				new Error('HTTP 400: {"code":723,"message":"Media corrupt"}')
			);
			error.statusCode = 400;
			throw error;
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
		adapter.getStateAsync = async () => ({ val: '' });
		adapter.setStateAsync = async () => {};

		await adapter.syncCameraHistory(camera, devId);
		const firstAttempts = attempts;

		await adapter.syncCameraHistory(camera, devId);
		const secondAttempts = attempts;

		const cooldownKey = `${devId}:corrupt-723`;

		// Abgelaufenen Cooldown simulieren.
		adapter.corruptCloudClipUntil.set(cooldownKey, Date.now() - 1);

		await adapter.syncCameraHistory(camera, devId);
		const thirdAttempts = attempts;

		// Dieselbe Clip-ID bei einer anderen Kamera testen.
		const otherCamera = {
			id: 'other-camera',
			name: 'Other Camera',
			network_id: 'other-network',
		};

		await adapter.syncCameraHistory(otherCamera, otherCamera.id);
		const fourthAttempts = attempts;

		return {
			firstAttempts,
			secondAttempts,
			thirdAttempts,
			fourthAttempts,
			cooldownActive: adapter.corruptCloudClipUntil.get(cooldownKey) > Date.now(),
			files: fs.readdirSync(dir),
		};
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe('Blink history file rollback', () => {
	it('rejects a failed backup manifest write without changing history', async () => {
		const result = await runScenario(false, false, true);

		assert.ok(result.syncError);
		assert.match(result.syncError.message, /Simulated manifest write failure/);

		assert.deepEqual(result.files, ['original-video-0', 'original-video-1']);

		assert.deepEqual(result.ids, ['old-0', 'old-1']);
		assert.equal(result.stateWrites, 0);
		assert.deepEqual(result.remainingTemp, []);
		assert.equal(result.lockReleased, true);
		assert.deepEqual(result.backupDirectories, []);
	});

	it('captures the complete backup manifest before replacing files', async () => {
		const result = await runScenario(false);
		const snapshot = result.manifestAtCommit;

		assert.ok(snapshot);

		const manifest = snapshot.manifest;

		assert.equal(manifest.version, 1);
		assert.equal(manifest.cameraId, 'camera-test');
		assert.equal(manifest.historySize, 10);
		assert.equal(Number.isNaN(Date.parse(manifest.createdAt)), false);

		assert.equal(manifest.originalFiles.length, 10);
		assert.deepEqual(Array.from(manifest.originalFiles), [
			true,
			true,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
		]);

		assert.equal(manifest.previousStates.length, 40);

		const previousStates = new Map(Array.from(manifest.previousStates, entry => [entry.key, entry.value]));

		assert.equal(previousStates.size, 40);

		assert.equal(previousStates.get('cameras.camera-test.video.history.0.id'), 'old-0');

		assert.equal(previousStates.get('cameras.camera-test.video.history.1.id'), 'old-1');

		for (let i = 0; i < 10; i++) {
			for (const field of ['file', 'timestamp', 'id', 'source']) {
				assert.equal(previousStates.has(`cameras.camera-test.video.history.${i}.${field}`), true);
			}
		}

		assert.equal(snapshot.backup0, 'original-video-0');
		assert.equal(snapshot.backup1, 'original-video-1');
		assert.equal(snapshot.live0, 'original-video-0');
		assert.equal(snapshot.live1, 'original-video-1');

		assert.deepEqual(result.backupDirectories, []);
	});

	it('updates files and IDs after a successful download', async () => {
		const result = await runScenario(false);

		assert.deepEqual(result.files, ['new-video-new-0', 'new-video-new-1']);
		assert.deepEqual(result.ids, ['new-0', 'new-1']);
		assert.ok(result.stateWrites > 0);
		assert.equal(result.renameAttempts, 1);
		assert.deepEqual(result.remainingTemp, []);
		assert.deepEqual(result.backupDirectories, []);
	});

	it('restores original files when the second rename fails', async () => {
		const result = await runScenario(true);

		assert.deepEqual(result.files, ['original-video-0', 'original-video-1']);
		assert.deepEqual(result.ids, ['old-0', 'old-1']);
		assert.equal(result.stateWrites, 0);
		assert.equal(result.renameAttempts, 1);
		assert.deepEqual(result.remainingTemp, []);
		assert.deepEqual(result.backupDirectories, []);
		assert.ok(result.warnings.some(message => message.includes('History update failed')));
	});

	it('restores files and IDs when writing a state fails', async () => {
		const result = await runScenario(false, true);

		assert.deepEqual(result.files, ['original-video-0', 'original-video-1']);
		assert.deepEqual(result.ids, ['old-0', 'old-1']);
		assert.deepEqual(result.remainingTemp, []);
		assert.deepEqual(result.backupDirectories, []);
	});

	it('does not retry a corrupt cloud clip during cooldown', async () => {
		const result = await runCorruptCloudScenario();

		assert.equal(result.firstAttempts, 1);
		assert.equal(result.secondAttempts, 1);
		assert.equal(result.thirdAttempts, 2);
		assert.equal(result.fourthAttempts, 3);
		assert.equal(result.cooldownActive, true);
		assert.deepEqual(result.files, []);
	});
});
