import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkStatus } from './bootstrap.ts'

const realFetch = globalThis.fetch
function answer(status: number): void {
  globalThis.fetch = (async () => new Response('{}', { status, statusText: String(status) })) as typeof fetch
}

test('a refused key (401/403) is not an outage', async () => {
  try {
    for (const s of [401, 403]) {
      answer(s)
      assert.equal(await checkStatus(), 'wip_key_refused', String(s))
    }
  } finally { globalThis.fetch = realFetch }
})

test('a server error or no answer is still unreachable', async () => {
  try {
    answer(503)
    assert.equal(await checkStatus(), 'wip_unreachable')
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    assert.equal(await checkStatus(), 'wip_unreachable')
  } finally { globalThis.fetch = realFetch }
})
