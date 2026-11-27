'use strict';

// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('mocha');

const source = fs.readFileSync(path.join(__dirname, '../lib/blink-api.js'), 'utf8');

const start = source.indexOf('function parseV4MediaResponse(');
const end = source.indexOf('\nfunction _isSystemBusyError(', start);

assert.ok(start >= 0);
assert.ok(end > start);

const parse = vm.runInNewContext(`(${source.slice(start, end).trim()})`);

describe('Blink v4 media response parser', () => {
	it('preserves a 19-digit pagination key', () => {
		const raw = '{"pagination_key":1234567890123456789,' + '"media":[{"id":1}]}';

		const result = parse(raw);

		assert.equal(result.pagination_key, '1234567890123456789');
		assert.equal(result.media.length, 1);
	});

	it('preserves a zero pagination key', () => {
		const result = parse('{"pagination_key":0,"media":[]}');

		assert.equal(result.pagination_key, '0');
	});

	it('accepts a null pagination key', () => {
		const result = parse('{"pagination_key":null,"media":[]}');

		assert.equal(result.pagination_key, null);
	});

	it('accepts an existing string key', () => {
		const result = parse('{"pagination_key":"abc123","media":[]}');

		assert.equal(result.pagination_key, 'abc123');
	});

	it('rejects invalid media lists', () => {
		assert.throws(() => parse('{"pagination_key":123,"media":null}'), /Invalid Blink v4 media list/);
	});

	it('rejects ambiguous numeric keys', () => {
		assert.throws(
			() => parse('{"pagination_key":123,' + '"media":[],"pagination_key":456}'),
			/Ambiguous Blink v4 pagination key/,
		);
	});
});
