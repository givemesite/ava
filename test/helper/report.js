'use strict';
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const globby = require('globby');
const proxyquire = require('proxyquire');
const replaceString = require('replace-string');

const Api = proxyquire('../../api', {
	'./lib/fork': proxyquire('../../lib/fork', {
		child_process: Object.assign({}, childProcess, { // eslint-disable-line camelcase
			fork(filename, argv, options) {
				return childProcess.fork(path.join(__dirname, 'report-worker.js'), argv, options);
			}
		})
	})
});

exports.assert = (t, logFile, buffer, stripStdIO) => {
	let existing = null;
	try {
		existing = fs.readFileSync(logFile);
	} catch (err) {}
	if (existing === null || process.env.UPDATE_REPORTER_LOG) {
		fs.writeFileSync(logFile, buffer);
		existing = buffer;
	}

	let expected = existing.toString('utf8');
	// At least in Appveyor with Node.js 6, IPC can overtake stdout/stderr. This
	// causes the reporter to emit in a different order, resulting in a test
	// failure. "Fix" by not asserting on the stdout/stderr reporting at all.
	if (stripStdIO && process.platform === 'win32' && parseInt(process.versions.node, 10) < 8) {
		expected = expected.replace(/---tty-stream-chunk-separator\n(stderr|stdout)\n/g, '');
	}
	t.is(buffer.toString('utf8'), expected);
};

exports.sanitizers = {
	cwd: str => replaceString(str, process.cwd(), '~'),
	posix: str => replaceString(str, '\\', '/'),
	slow: str => str.replace(/(slow.+?)\(\d+m?s\)/g, '$1 (000ms)'),
	// TODO: Remove when Node.js 4 support is dropped
	stacks: str => str.replace(/(\[90m|')t \((.+?\.js:\d+:\d+)\)/g, '$1$2').replace(/null\._onTimeout/g, 'Timeout.setTimeout'),
	// At least in Appveyor with Node.js 6, IPC can overtake stdout/stderr. This
	// causes the reporter to emit in a different order, resulting in a test
	// failure. "Fix" by not asserting on the stdout/stderr reporting at all.
	unreliableProcessIO(str) {
		if (process.platform !== 'win32' || parseInt(process.versions.node, 10) >= 8) {
			return str;
		}

		return str === 'stdout\n' || str === 'stderr\n' ? '' : str;
	}
};

const run = (type, reporter) => {
	const projectDir = path.join(__dirname, '../fixture/report', type.toLowerCase());

	const api = new Api({
		failFast: type === 'failFast' || type === 'failFast2',
		failWithoutAssertions: false,
		serial: type === 'failFast' || type === 'failFast2',
		require: [],
		cacheEnable: true,
		compileEnhancements: true,
		match: [],
		babelConfig: {testOptions: {}},
		resolveTestsFrom: projectDir,
		projectDir,
		timeout: undefined,
		concurrency: 1,
		updateSnapshots: false,
		snapshotDir: false,
		color: true
	});

	api.on('run', plan => reporter.startRun(plan));

	const files = globby.sync('*.js', {cwd: projectDir}).sort();
	if (type !== 'watch') {
		return api.run(files).then(() => {
			reporter.endRun();
		});
	}

	// Mimick watch mode
	return api.run(files, {clearLogOnNextRun: false, previousFailures: 0, runVector: 1}).then(() => {
		reporter.endRun();
		return api.run(files, {clearLogOnNextRun: true, previousFailures: 2, runVector: 2});
	}).then(() => {
		reporter.endRun();
		return api.run(files, {clearLogOnNextRun: false, previousFailures: 0, runVector: 3});
	}).then(() => {
		reporter.endRun();
	});
};

exports.regular = reporter => run('regular', reporter);
exports.failFast = reporter => run('failFast', reporter);
exports.failFast2 = reporter => run('failFast2', reporter);
exports.only = reporter => run('only', reporter);
exports.watch = reporter => run('watch', reporter);
