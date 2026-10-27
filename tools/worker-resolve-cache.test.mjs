// Offline /resolve cache regressions. All upstream HTML and time are controlled.
// Run: node --test tools/worker-resolve-cache.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/src/index.js', import.meta.url), 'utf8');
const UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let fixtureNumber = 0;

async function fixture(run) {
  const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#fixture-' + (++fixtureNumber))).default;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const state = { now: 1000000, duration: null, calls: 0 };
  Date.now = () => state.now;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://suno-fixture.invalid');
    assert.ok(['/embed/' + UUID, '/song/' + UUID].includes(url.pathname));
    state.calls++;
    const metadata = state.duration == null ? { id: UUID } : { id: UUID, duration: state.duration };
    return new Response('<html><head><title>Fixture Song by Fixture Artist | Suno</title>' +
      '<meta property="og:title" content="Fixture Song"></head><body><script>' +
      JSON.stringify(metadata) + '</script></body></html>', {
      headers: { 'Content-Type': 'text/html' }
    });
  };
  const resolve = async () => {
    const response = await worker.fetch(
      new Request('https://worker-fixture.invalid/resolve?id=' + UUID),
      { TEST_SUNO_ORIGIN: 'https://suno-fixture.invalid' },
      {}
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.metaStatus, 'ok');
    return body;
  };
  try {
    await run(state, resolve);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
}

test('a title-only resolve retries after 15 seconds and recovers duration', async () => {
  await fixture(async (state, resolve) => {
    const first = await resolve();
    assert.equal(first.title, 'Fixture Song');
    assert.equal(first.durationSeconds, null);
    assert.equal(state.calls, 2);

    state.duration = 209.8;
    state.now += 14999;
    const cached = await resolve();
    assert.equal(cached.cached, true);
    assert.equal(cached.durationSeconds, null);
    assert.equal(state.calls, 2, 'incomplete responses still prevent rapid repeat upstream requests');

    state.now++;
    const recovered = await resolve();
    assert.equal(recovered.durationSeconds, 209.8);
    assert.equal(recovered.cached, undefined);
    assert.equal(state.calls, 4, 'both metadata pages are retried at the short TTL boundary');

    state.now += 15000;
    const complete = await resolve();
    assert.equal(complete.cached, true);
    assert.equal(complete.durationSeconds, 209.8);
    assert.equal(state.calls, 4, 'recovered duration gets the normal long cache lifetime');
  });
});

test('known duration remains cached for six hours, then refreshes', async () => {
  await fixture(async (state, resolve) => {
    state.duration = 180;
    const first = await resolve();
    assert.equal(first.durationSeconds, 180);
    assert.equal(state.calls, 2);

    state.duration = 181;
    state.now += 6 * 60 * 60 * 1000 - 1;
    const cached = await resolve();
    assert.equal(cached.cached, true);
    assert.equal(cached.durationSeconds, 180);
    assert.equal(state.calls, 2);

    state.now++;
    const refreshed = await resolve();
    assert.equal(refreshed.durationSeconds, 181);
    assert.equal(refreshed.cached, undefined);
    assert.equal(state.calls, 4);
  });
});
