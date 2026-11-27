'use strict';

// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('mocha');

const source = fs.readFileSync(path.join(__dirname, '../lib/blink-api.js'), 'utf8');

const start = source.indexOf('async function getV4CloudClips(');
const end = source.indexOf('async function getCloudClips(', start);

assert.ok(start >= 0);
assert.ok(end > start);

function createTest(responses) {
	const requests = [];
	const logs = [];

	const context = {
		URLSearchParams,
		Date,
		_getAccountId: async () => 456,
		_restPost: async url => {
			requests.push(url);
			return responses[requests.length - 1];
		},
		dbg: msg => logs.push(String(msg)),
	};

	const getV4CloudClips = vm.runInNewContext(`(${source.slice(start, end).trim()})`, context);

	return { getV4CloudClips, requests, logs };
}

const session = {
	accessToken: 'SECRET_TOKEN',
	apiHost: 'example.invalid',
};

describe('Blink v4 cloud clip listing', () => {
	it('filters cameras and follows a large pagination key', async () => {
		const test = createTest([
			{
				pagination_key: '1234567890123456789',
				media: [
					{
						id: 1,
						device_id: 123,
						network_id: 789,
						created_at: '2026-11-27T01:00:00Z',
						media: '/video1',
					},
					{
						id: 2,
						device_id: 999,
						network_id: 789,
						media: '/wrong-camera',
					},
					{
						id: 3,
						device_id: 123,
						network_id: 999,
						media: '/wrong-network',
					},
				],
			},
			{
				pagination_key: null,
				media: [
					{
						id: 4,
						device_id: 123,
						network_id: 789,
						created_at: '2026-11-26T12:00:00Z',
						media: '/video4',
					},
				],
			},
		]);

		const result = await test.getV4CloudClips(session, 789, 123, 'Testkamera', 10);

		assert.equal(result.clips.length, 2);
		assert.deepEqual(
			Array.from(result.clips, clip => clip.id),
			['1', '4'],
		);

		assert.equal(test.requests.length, 2);
		assert.match(test.requests[0], /start_time=/);
		assert.match(test.requests[1], /pagination_key=1234567890123456789/);

		assert.ok(test.logs.every(line => !line.includes('SECRET_TOKEN')));
	});

	it('rejects unsafe pagination values', async () => {
		const test = createTest([
			{
				pagination_key: 1234567890123456700,
				media: [],
			},
		]);

		await assert.rejects(test.getV4CloudClips(session, 789, 123, 'Testkamera'), /Unsafe Blink v4 pagination key/);
	});

	it('stops at the end of pagination', async () => {
		const test = createTest([
			{
				pagination_key: null,
				media: [],
			},
		]);

		const result = await test.getV4CloudClips(session, 789, 123, 'Testkamera');

		assert.equal(result.clips.length, 0);
		assert.equal(test.requests.length, 1);
	});

	it('finds newer clips on later API pages', async () => {
		const test = createTest([
			{
				pagination_key: '1234567890123456789',
				media: [
					{
						id: 100,
						device_id: 123,
						network_id: 789,
						created_at: '2026-11-20T10:00:00Z',
						media: '/older.mp4',
					},
				],
			},
			{
				pagination_key: null,
				media: [
					{
						id: 200,
						device_id: 123,
						network_id: 789,
						created_at: '2026-11-27T10:00:00Z',
						media: '/newer.mp4',
					},
				],
			},
		]);

		const result = await test.getV4CloudClips(session, 789, 123, 'Testkamera', 1);

		assert.equal(result.clips.length, 1);
		assert.equal(result.clips[0].id, '200');
		assert.equal(test.requests.length, 2);
	});
});
