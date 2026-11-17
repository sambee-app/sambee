const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../scripts/build-search.js'), 'utf8');

function run(arguments, environment = {}, result = { status: 0 }) {
  let invocation;
  let status;
  const errors = [];
  vm.runInNewContext(script, {
    require: () => ({ spawnSync: (...args) => { invocation = args; return result; } }),
    process: { argv: ['node', 'build-search.js', ...arguments], env: environment, exit: code => { status = code; } },
    console: { error: message => errors.push(message) },
  });
  return { invocation, status, errors };
}

test('development search bounds threads and forwards Pagefind arguments', () => {
  const { invocation: [command, arguments, options], status } = run(['--development', '--site', 'public-dev']);
  assert.equal(command, 'npx');
  assert.deepEqual(Array.from(arguments), ['--no-install', 'pagefind', '--site', 'public-dev']);
  assert.equal(options.env.RAYON_NUM_THREADS, '4');
  assert.equal(status, 0);
});

test('production and explicit thread settings remain unchanged', () => {
  assert.equal(run(['--site', 'public']).invocation[2].env.RAYON_NUM_THREADS, undefined);
  assert.equal(run(['--development'], { RAYON_NUM_THREADS: '2' }).invocation[2].env.RAYON_NUM_THREADS, '2');
});

test('indexing failure and spawn errors propagate', () => {
  assert.equal(run([], {}, { status: 7 }).status, 7);
  const failure = run([], {}, { status: null, error: new Error('not installed') });
  assert.equal(failure.status, 1);
  assert.match(failure.errors[0], /not installed/);
});
