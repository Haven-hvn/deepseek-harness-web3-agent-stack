import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshLive } from '../src/live.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('live qbittorrent status', () => {
  it('reports RUNNING when the WebUI answers 403 (auth required)', async () => {
    vi.stubGlobal('fetch', async (url: unknown) => {
      const target = String(url)
      if (target.includes(':8080')) return new Response('Forbidden', { status: 403 })
      if (target.includes('/transmission/rpc')) return new Response('', { status: 409 })
      return new Response('', { status: 200 })
    })
    // Unreachable supervisor socket forces the HTTP-probe fallback path.
    const live = await refreshLive(
      {
        qbittorrentUrl: 'http://127.0.0.1:8080',
        transmissionUrl: 'http://127.0.0.1:9091',
        prowlarrUrl: 'http://127.0.0.1:9696',
        supervisorSock: '/nonexistent/supervisor.sock',
        acquireStore: '/nonexistent/acquire.json',
      },
      [],
      null,
      null,
      null,
    )
    expect(live.status.find(row => row.program === 'qbittorrent')).toMatchObject({ state: 'RUNNING' })
  })
})
