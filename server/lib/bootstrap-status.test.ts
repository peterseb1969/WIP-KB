import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkStatus, checkStatusDetail } from './bootstrap.ts'

const realFetch = globalThis.fetch
function answer(status: number): void {
  globalThis.fetch = (async () => new Response('{}', { status, statusText: String(status) })) as typeof fetch
}

test('a refused key (401/403) is not an outage', async () => {
  try {
    for (const s of [401, 403]) {
      answer(s)
      assert.equal(await checkStatus(), 'wip_key_refused', String(s))
      assert.equal((await checkStatusDetail()).http_status, s)
    }
  } finally { globalThis.fetch = realFetch }
})

test('another error status from WIP is a WIP error, with its status', async () => {
  try {
    for (const s of [500, 503, 404]) {
      answer(s)
      const d = await checkStatusDetail()
      assert.equal(d.status, 'wip_error', String(s))
      assert.equal(d.http_status, s)
    }
  } finally { globalThis.fetch = realFetch }
})

test('no answer at all is unreachable', async () => {
  try {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    const d = await checkStatusDetail()
    assert.equal(d.status, 'wip_unreachable')
    assert.equal(d.http_status, undefined)
    assert.match(d.error ?? '', /fetch failed/)
  } finally { globalThis.fetch = realFetch }
})
