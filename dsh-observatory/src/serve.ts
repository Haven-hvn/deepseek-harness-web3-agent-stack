import { createServer } from 'node:http'
import { buildSnapshot, EMPTY_LIVE } from './snapshot.ts'
import { ObservatoryStore } from './store.ts'

const dir = process.env['OBSERVATORY_DIR'] ?? '/data/observatory'
const host = process.env['DASHBOARD_HOST'] ?? '0.0.0.0'
const port = Number(process.env['DASHBOARD_PORT'] ?? 8787)
const store = new ObservatoryStore(dir)

const page = `<!doctype html>
<meta charset="utf-8">
<title>dsh-haven agent</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<label>window <select id="since"><option>24h</option><option selected>7d</option><option>30d</option></select></label>
<div id="root"></div>
<script>
const panels = ['status','downloads','treasury','balances','burn','tokens','revenue','launches','catalog']
async function load() {
  const since = document.getElementById('since').value
  const snap = await (await fetch('/snapshot?since=' + since)).json()
  const root = document.getElementById('root')
  root.replaceChildren()
  for (const name of panels) {
    const h = document.createElement('h2')
    h.textContent = name
    root.append(h)
    const rows = Array.isArray(snap[name]) ? snap[name] : snap[name] ? [snap[name]] : []
    root.append(table(rows))
    if (['balances','burn','tokens','revenue'].includes(name)) root.append(chart(name, rows))
  }
}
function table(rows) {
  const t = document.createElement('table')
  const keys = [...new Set(rows.flatMap(Object.keys))]
  const head = document.createElement('tr')
  for (const key of keys) {
    const th = document.createElement('th')
    th.textContent = key
    head.append(th)
  }
  t.append(head)
  for (const row of rows) {
    const tr = document.createElement('tr')
    for (const key of keys) {
      const td = document.createElement('td')
      const value = row[key]
      if (key === 'explorer' && value) {
        const a = document.createElement('a')
        a.href = value
        a.textContent = value
        td.append(a)
      } else td.textContent = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
      tr.append(td)
    }
    t.append(tr)
  }
  return t
}
function chart(name, rows) {
  const canvas = document.createElement('canvas')
  const labels = rows.map(row => new Date(row.ts || 0).toISOString())
  const data = rows.map(row => row.usd ?? row.amount ?? row.tokens ?? 0)
  new Chart(canvas, { type: 'line', data: { labels, datasets: [{ label: name, data }] } })
  return canvas
}
document.getElementById('since').onchange = load
load()
</script>`

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
