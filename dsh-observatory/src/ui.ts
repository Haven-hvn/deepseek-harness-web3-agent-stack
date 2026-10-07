/**
 * Read-only dashboard page: HTML, CSS, and browser JS.
 * Presentation only — the server hands this string out unchanged and all
 * data still arrives via /snapshot and /health.
 * @module dsh-observatory/ui
 */

export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-haven web3 agent — observatory</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
:root {
  --surface: #f9f6f1;
  --surface-raised: #fefdfa;
  --surface-deep: #f1ede5;
  --surface-sunk: #e9e3d9;
  --ink: #11141a;
  --fg2: #44484f;
  --fg3: #53575f;
  --fg4: #5f636b;
  --fg5: #8f9299;
  --ember: #d63411;
  --seal: #ff7329;
  --seal-text: #b71d00;
  --seal-wash: rgba(214, 52, 17, .085);
  --seal-edge: rgba(214, 52, 17, .34);
  --line: rgba(17, 20, 26, .145);
  --line-soft: rgba(17, 20, 26, .07);
  --line-strong: rgba(17, 20, 26, .62);
  --mono: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  --sans: 'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--surface);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.grain {
  position: fixed; inset: 0; z-index: 9999; pointer-events: none;
  opacity: .05; mix-blend-mode: multiply;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
}
.masthead {
  position: sticky; top: 0; z-index: 100;
  background: rgba(249, 246, 241, .85);
  backdrop-filter: blur(24px) saturate(1.6);
  -webkit-backdrop-filter: blur(24px) saturate(1.6);
  border-bottom: 1px solid var(--line);
}
.mast-inner {
  max-width: 1200px; margin: 0 auto; padding: 15px 24px;
  display: flex; align-items: center; gap: 18px;
}
.wordmark { font-size: 17px; font-weight: 600; letter-spacing: -.03em; white-space: nowrap; }
.wordmark.small { font-size: 13px; }
.vrule { width: 1px; height: 18px; background: var(--line-strong); flex: none; }
.descriptor {
  font-family: var(--mono); font-size: 10px; letter-spacing: .18em;
  color: var(--fg5); text-transform: uppercase; white-space: nowrap;
}
.mast-right { margin-left: auto; display: flex; align-items: center; gap: 16px; }
.xmtp {
  display: flex; align-items: center;
  font-family: var(--mono); font-size: 10px; letter-spacing: .14em;
  color: var(--fg4); text-transform: uppercase; white-space: nowrap;
  cursor: default;
}
.seal-mark {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: .16em;
  color: var(--seal-text); background: var(--seal-wash);
  border: 1px solid var(--seal-edge); padding: 5px 9px;
  text-transform: uppercase; white-space: nowrap;
}
.chips { display: flex; border: 1px solid var(--line-strong); }
.chips button {
  font-family: var(--mono); font-size: 10px; letter-spacing: .14em;
  background: transparent; border: 0; border-left: 1px solid var(--line);
  color: var(--fg3); padding: 7px 14px; cursor: pointer; text-transform: uppercase;
}
.chips button:first-child { border-left: 0; }
.chips button:hover { background: var(--seal-wash); color: var(--seal-text); }
.chips button.active { background: var(--seal); color: #14100c; font-weight: 500; }
main { max-width: 1200px; margin: 0 auto; padding: 40px 24px 72px; }
.act { border-top: 1px solid var(--line-strong); padding: 26px 0 34px; }
.act:first-child { border-top: 0; padding-top: 0; }
.act.crop { position: relative; }
.act.crop::before, .act.crop::after {
  content: ''; position: absolute; width: 9px; height: 9px;
  border: 1px solid var(--ink); opacity: .4;
}
.act.crop::before { top: -4px; left: -4px; border-right: 0; border-bottom: 0; }
.act.crop::after { bottom: 14px; right: -4px; border-left: 0; border-top: 0; }
.section-head {
  display: flex; align-items: baseline; gap: 14px;
  margin-bottom: 14px; padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
}
.folio { font-family: var(--mono); font-size: 11px; color: var(--seal-text); letter-spacing: .1em; font-weight: 500; }
.section-head h2 {
  margin: 0; font-family: var(--mono); font-size: 13px; font-weight: 500;
  letter-spacing: .15em; text-transform: uppercase;
}
.section-meta {
  margin-left: auto; font-family: var(--mono); font-size: 10px;
  letter-spacing: .12em; color: var(--fg5); text-transform: uppercase;
}
.grid-frame {
  border: 1px solid var(--line); background: var(--surface-raised);
  overflow-x: auto;
}
.act.key .grid-frame, .act.key .empty {
  border-color: var(--line-strong);
  outline: 1px solid var(--line-soft); outline-offset: 4px;
}
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: .15em;
  text-transform: uppercase; color: var(--fg5); text-align: left; font-weight: 500;
  padding: 10px 14px; background: var(--surface-deep);
  border-bottom: 1px solid var(--line); white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
td {
  padding: 11px 14px; border-bottom: 1px solid var(--line-soft);
  vertical-align: middle; color: var(--fg2);
}
tr:last-child td { border-bottom: 0; }
tr:hover td { background: var(--seal-wash); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.mono { font-family: var(--mono); font-size: 12px; }
.trunc {
  font-family: var(--mono); font-size: 12px;
  max-width: 24ch; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; display: inline-block; vertical-align: bottom;
}
.pip {
  display: inline-block; width: 7px; height: 7px; margin-right: 8px;
  vertical-align: middle; position: relative; background: var(--fg5); flex: none;
}
.pip.up { background: #009a4d; }
.pip.down { background: var(--ember); }
.pip::after {
  content: ''; position: absolute; inset: -3px; background: inherit;
  animation: breathe 2.6s ease-in-out infinite;
}
@keyframes breathe { 0%, 100% { transform: scale(.7); opacity: .2; } 50% { transform: scale(1.15); opacity: .45; } }
.bar { display: flex; align-items: center; gap: 10px; min-width: 150px; }
.bar .track {
  flex: 1; height: 6px; background: var(--surface-sunk);
  border: 1px solid var(--line); position: relative;
}
.bar .fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ember); }
.bar .pct {
  font-family: var(--mono); font-size: 11px; color: var(--fg3);
  font-variant-numeric: tabular-nums; min-width: 4ch; text-align: right;
}
a.link-rule {
  color: var(--seal-text); text-decoration: none;
  font-family: var(--mono); font-size: 11.5px; letter-spacing: .04em;
  background-image: linear-gradient(var(--ember), var(--ember));
  background-repeat: no-repeat; background-position: 0 100%; background-size: 0 1px;
  transition: background-size .48s cubic-bezier(.2, .7, .2, 1);
}
a.link-rule:hover { background-size: 100% 1px; }
.empty {
  font-family: var(--mono); font-size: 11px; letter-spacing: .15em;
  color: var(--fg5); padding: 30px; text-align: center;
  background: var(--surface-raised); border: 1px dashed var(--line);
  text-transform: uppercase;
}
.chart-frame {
  margin-top: 14px; border: 1px solid var(--line);
  background: var(--surface-raised); padding: 18px 16px 10px;
}
.chart-frame canvas { max-height: 230px; }
footer { border-top: 1px solid var(--line-strong); background: var(--surface-deep); }
.foot-inner {
  max-width: 1200px; margin: 0 auto; padding: 22px 24px;
  display: flex; gap: 18px; align-items: baseline; flex-wrap: wrap;
}
.foot-tag {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: .14em;
  color: var(--fg5); text-transform: uppercase;
}
.foot-tag.dim { color: var(--fg4); }
#generated {
  margin-left: auto; font-family: var(--mono); font-size: 10px;
  letter-spacing: .12em; color: var(--fg5); font-variant-numeric: tabular-nums;
}
@media (max-width: 760px) {
  .descriptor, .seal-mark { display: none; }
  .mast-inner { padding: 12px 16px; }
  main { padding: 28px 16px 56px; }
}
</style>
</head>
<body>
<div class="grain" aria-hidden="true"></div>
<header class="masthead">
  <div class="mast-inner">
    <span class="wordmark">dsh-haven web3 agent</span>
    <span class="vrule"></span>
    <span class="descriptor">agent observatory</span>
    <div class="mast-right">
      <span class="xmtp" id="xmtp-ind" title="xmtp state"><span class="pip"></span><span id="xmtp-label">xmtp</span></span>
      <span class="seal-mark">read-only · redacted</span>
      <nav class="chips" id="since" aria-label="window">
        <button data-since="24h">24h</button>
        <button data-since="7d" class="active">7d</button>
        <button data-since="30d">30d</button>
      </nav>
    </div>
  </div>
</header>
<main id="root"></main>
<footer>
  <div class="foot-inner">
    <span class="wordmark small">dsh-haven web3 agent</span>
    <span class="foot-tag">arkiv · icp · evm · filecoin — no private backend</span>
    <span class="foot-tag dim">redacted at source · no keys · no prompts</span>
    <span id="generated"></span>
  </div>
</footer>
<script>
const PANELS = ['status', 'downloads', 'treasury', 'balances', 'burn', 'tokens', 'revenue', 'launches', 'catalog']
const CHARTED = ['balances', 'burn', 'tokens', 'revenue']
const MONEY = ['usd', 'totalValueUsd', 'dailyBurnUsd', 'seedUsd', 'price', 'roi']
const BYTES = ['bytesLeft', 'speed']
const TIMES = ['ts', 'expiresAt']
const DOWN = /stop|exit|fatal|fail|error|backoff|unknown|disconnected/i
const UP = /run|active|connect|download|seed|ok|start|healthy|done|complete/i
let since = '7d'
let charts = []

function fmtMoney(v) {
  return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtBytes(v) {
  const n = Number(v)
  if (!isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let x = n
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++ }
  return (x >= 100 ? Math.round(x) : x.toFixed(1)) + ' ' + units[i]
}
function fmtTime(v) {
  return new Date(Number(v)).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}
function isAddr(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
}
function shortAddr(v) {
  return v.slice(0, 6) + '…' + v.slice(-4)
}

function cell(td, key, value) {
  if (value == null || value === '') return
  if (key === 'explorer' && String(value).startsWith('http')) {
    const a = document.createElement('a')
    a.className = 'link-rule'
    a.href = value
    a.target = '_blank'
    a.rel = 'noopener'
    a.textContent = '↗ open'
    a.title = String(value)
    td.append(a)
    return
  }
  if (key === 'state') {
    const s = String(value)
    const pip = document.createElement('span')
    pip.className = 'pip ' + (DOWN.test(s) ? 'down' : UP.test(s) ? 'up' : '')
    td.append(pip, document.createTextNode(s))
    return
  }
  if (key === 'progress' && typeof value === 'number') {
    const pct = Math.max(0, Math.min(1, value))
    const bar = document.createElement('div')
    bar.className = 'bar'
    const track = document.createElement('div')
    track.className = 'track'
    const fill = document.createElement('div')
    fill.className = 'fill'
    fill.style.width = (pct * 100).toFixed(1) + '%'
    track.append(fill)
    const label = document.createElement('span')
    label.className = 'pct'
    label.textContent = Math.round(pct * 100) + '%'
    bar.append(track, label)
    td.append(bar)
    return
  }
  if (MONEY.includes(key) && typeof value === 'number') {
    td.className = td.className + ' num'
    td.textContent = fmtMoney(value)
    return
  }
  if (BYTES.includes(key) && typeof value === 'number') {
    td.className = td.className + ' num'
    td.textContent = fmtBytes(value) + (key === 'speed' ? '/s' : '')
    return
  }
  if (TIMES.includes(key) && typeof value === 'number') {
    const span = document.createElement('span')
    span.className = 'mono'
    span.textContent = fmtTime(value)
    td.append(span)
    return
  }
  if (isAddr(value)) {
    const span = document.createElement('span')
    span.className = 'trunc'
    span.textContent = shortAddr(value)
    span.title = value
    td.append(span)
    return
  }
  if (typeof value === 'number') {
    td.className = td.className + ' num'
    td.textContent = String(value)
    return
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (text.length > 24) {
    const span = document.createElement('span')
    span.className = 'trunc'
    span.textContent = text
    span.title = text
    td.append(span)
  } else {
    td.textContent = text
  }
}

function table(rows) {
  const frame = document.createElement('div')
  frame.className = 'grid-frame'
  if (!rows.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '— no rows in this window —'
    return empty
  }
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
      cell(td, key, row[key])
      tr.append(td)
    }
    t.append(tr)
  }
  frame.append(t)
  return frame
}

function chart(name, rows) {
  const frame = document.createElement('div')
  frame.className = 'chart-frame'
  const canvas = document.createElement('canvas')
  frame.append(canvas)
  const labels = rows.map(row => fmtTime(row.ts || 0).slice(5))
  const data = rows.map(row => row.usd ?? row.amount ?? row.tokens ?? 0)
  const c = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: name,
        data,
        borderColor: '#d63411',
        backgroundColor: 'rgba(255, 115, 41, .09)',
        borderWidth: 1.5,
        pointRadius: 2.5,
        pointStyle: 'rect',
        pointBackgroundColor: '#d63411',
        fill: true,
        tension: 0,
      }],
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#11141a',
          titleFont: { family: 'Geist Mono', size: 10 },
          bodyFont: { family: 'Geist Mono', size: 11 },
          displayColors: false,
          cornerRadius: 0,
          padding: 8,
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(17, 20, 26, .07)' },
          ticks: { color: '#8f9299', font: { family: 'Geist Mono', size: 9 }, maxRotation: 0, maxTicksLimit: 7 },
        },
        y: {
          grid: { color: 'rgba(17, 20, 26, .07)' },
          ticks: {
            color: '#8f9299',
            font: { family: 'Geist Mono', size: 9 },
            callback: function (v) {
              const n = Number(v)
              if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'm'
              if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k'
              return n
            },
          },
        },
      },
    },
  })
  charts.push(c)
  return frame
}

function section(index, name, rows) {
  const sec = document.createElement('section')
  let cls = 'act'
  if (name === 'status') cls += ' key'
  if (name === 'status' || name === 'treasury') cls += ' crop'
  sec.className = cls

  const head = document.createElement('div')
  head.className = 'section-head'
  const folio = document.createElement('span')
  folio.className = 'folio'
  folio.textContent = String(index + 1).padStart(2, '0')
  const h2 = document.createElement('h2')
  h2.textContent = name
  const meta = document.createElement('span')
  meta.className = 'section-meta'
  meta.textContent = rows.length + (rows.length === 1 ? ' row' : ' rows')
  head.append(folio, h2, meta)
  sec.append(head)
  sec.append(table(rows))
  if (CHARTED.includes(name) && rows.length) sec.append(chart(name, rows))
  return sec
}

async function load() {
  const snap = await (await fetch('/snapshot?since=' + since)).json()
  for (const c of charts) c.destroy()
  charts = []
  const root = document.getElementById('root')
  root.replaceChildren()
  PANELS.forEach((name, i) => {
    const rows = Array.isArray(snap[name]) ? snap[name] : snap[name] ? [snap[name]] : []
    root.append(section(i, name, rows))
  })
  const x = document.getElementById('xmtp-ind')
  const st = snap.xmtp && snap.xmtp.status ? String(snap.xmtp.status) : ''
  x.querySelector('.pip').className = 'pip ' + (st ? (DOWN.test(st) ? 'down' : UP.test(st) ? 'up' : '') : 'down')
  document.getElementById('xmtp-label').textContent = st ? 'xmtp · ' + st : 'xmtp offline'
  x.title = snap.xmtp && snap.xmtp.reason ? snap.xmtp.reason : 'no xmtp state reported'
  document.getElementById('generated').textContent = 'generated ' + fmtTime(snap.generatedAt)
}

const chips = document.querySelectorAll('#since button')
chips.forEach(btn => btn.addEventListener('click', () => {
  chips.forEach(x => x.classList.remove('active'))
  btn.classList.add('active')
  since = btn.dataset.since
  load()
}))
load()
</script>
</body>
</html>
`
