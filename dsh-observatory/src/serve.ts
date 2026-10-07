import { createServer } from 'node:http'
import { buildSnapshot, EMPTY_LIVE } from './snapshot.ts'
import { ObservatoryStore } from './store.ts'
import { page } from './ui.ts'

const dir = process.env['OBSERVATORY_DIR'] ?? '/data/observatory'
const host = process.env['DASHBOARD_HOST'] ?? '0.0.0.0'
const port = Number(process.env['DASHBOARD_PORT'] ?? 8787)
const store = new ObservatoryStore(dir)

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/health') {
    const live = store.readLive()
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ status: live.status, xmtp: live.xmtp }))
    return
  }
  if (url.pathname === '/snapshot') {
    const snap = buildSnapshot(store.readLedger(), store.readLive() ?? EMPTY_LIVE, {
      since: url.searchParams.get('since'),
      token: url.searchParams.get('token'),
    })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(snap))
    return
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(page)
})

server.listen(port, host, () => {
  console.log(`dashboard listening on ${host}:${port}`)
})
