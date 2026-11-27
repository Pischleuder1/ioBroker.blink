'use strict';

// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('mocha');

const source = fs.readFileSync(path.join(__dirname, '../lib/blink-api.js'), 'utf8');

const start = source.indexOf('async function getLatestVideoInfo(');
const end = source.indexOf('function normalizeMediaUrl(', start);

assert.ok(start >= 0);
assert.ok(end > start);

/**
 * @param {object|null} result - Mocked response.
 * @param {Error|null} [error] - Simulated error.
 */
function createTest(result, error = null) {
	const calls = [];

	const context = {
		getV4CloudClips: async (...args) => {
			calls.push(args);

			if (error) {
				throw error;
			}

			return result;
		},
	};

	const getLatestVideoInfo = vm.runInNewContext(`(${source.slice(start, end).trim()})`, context);

	return { getLatestVideoInfo, calls };
}

describe('Blink v4 latest video selection', () => {
	it('returns the newest v4 clip in download-compatible format', async () => {
		const test = createTest({
			source: 'cloud',
			clips: [
				{
					id: '12345',
					created_at: '2026-11-27T01:50:11Z',
					_cloudUrl: '/media/current.mp4',
					source: 'cloud',
					type: 'video',
					event_type: 'motion',
					metadata: '{"pts_length_ms":10000}',
					cv_detection: [],
					ai_vd: null,
				},
			],
		});

		const result = await test.getLatestVideoInfo({ accessToken: 'test' }, 789, 123);

		assert.equal(result.id, '12345');
		assert.equal(result.created_at, '2026-11-27T01:50:11Z');
		assert.equal(result.media, '/media/current.mp4');
		assert.equal(result.source, 'cloud');
		assert.equal(result.type, 'video');
		assert.equal(result.event_type, 'motion');
		assert.equal(result.metadata, '{"pts_length_ms":10000}');
		assert.deepEqual(Array.from(result.cv_detection), []);
		assert.equal(result.ai_vd, null);
		assert.equal(test.calls.length, 1);
		assert.equal(test.calls[0][1], 789);
		assert.equal(test.calls[0][2], 123);
		assert.equal(test.calls[0][4], 1);
	});

	it('does not silently fall back to stale v1 videos', async () => {
		const test = createTest({
			source: 'cloud',
			clips: [],
		});

		await assert.rejects(
			test.getLatestVideoInfo({}, 789, 123),
			err => err != null && typeof err === 'object' && 'code' in err && err.code === 'NO_VIDEO',
		);
	});

	it('propagates v4 API failures instead of returning old clips', async () => {
		const failure = new Error('V4 API unavailable');
		const test = createTest(null, failure);

		await assert.rejects(test.getLatestVideoInfo({}, 789, 123), /V4 API unavailable/);
	});
});
