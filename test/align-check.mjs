// 量一下气泡和牛的对齐关系（等动画落定后再量）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(DIR, '_align.png')
const PORT = 9271
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-align-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;background:#0e1116">
<div style="padding:20px;color:#8b97a8;font:13px system-ui">对齐检查</div>
<script src="/dsh-cow-pet/pet.js"></script>`

function serve(files) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const url = req.url.split('?')[0]
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(PAGE)
        return
      }
      const key = Object.keys(files).find((k) => url.startsWith(k))
      if (!key) { res.writeHead(404); res.end('nope'); return }
      const body = files[key](req)
      res.writeHead(200, { 'Content-Type': body.type, 'Cache-Control': 'no-store' })
      res.end(body.buf)
    })
    s.listen(PORT, '127.0.0.1', () => resolve(s))
  })
}

;(async () => {
  const state = JSON.stringify({ state: { enabled: true, x: 700, y: Number(process.env.COW_Y || 330), size: 132 }, sprites: ['think', 'cry', 'smug', 'ride', 'walk', 'oops'] })
  const files = {
    '/dsh-cow-pet/pet.js': () => ({ type: 'application/javascript', buf: fs.readFileSync(path.join(DIR, 'lib', 'pet.js')) }),
    '/dsh-cow-pet/state.json': () => ({ type: 'application/json', buf: Buffer.from(state) }),
    '/dsh-cow-pet/startup.webp': () => ({ type: 'image/webp', buf: fs.readFileSync(path.join(DIR, 'assets', 'startup', 'startup.webp')) }),
    '/dsh-cow-pet/asset/': () => ({ type: 'image/png', buf: fs.readFileSync(path.join(DIR, 'assets', 'cow', 'walk.png')) }),
  }
  const server = await serve(files)
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=9250`, `--user-data-dir=${profile}`,
    '--no-first-run', '--window-size=900,620', `http://127.0.0.1:${PORT}/`], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9250/json')).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch { await sleep(250) }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id
    pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)))
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(1400)

  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const card = document.querySelector('.dsh-cow-pet-card')
      const pet = document.querySelector('.dsh-cow-pet')
      if (!card) return JSON.stringify({card:null})
      const c = card.getBoundingClientRect(), p = pet.getBoundingClientRect()
      return JSON.stringify({
        card:[Math.round(c.x),Math.round(c.y),Math.round(c.width),Math.round(c.height)],
        pet:[Math.round(p.x),Math.round(p.y),Math.round(p.width),Math.round(p.height)],
        cardCenterX: Math.round(c.x + c.width/2), petCenterX: Math.round(p.x + p.width/2),
        gapAbovePet: Math.round(p.y - (c.y + c.height)),
        place: window.__dshCowPlace,
        flip: card.classList.contains('flip'),
        marginLeft: card.style.marginLeft,
        tailX: Math.round(c.x + c.width/2)
      })
    })()`,
    returnByValue: true,
  })
  console.log('ALIGN', r.result.value)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log('SHOT', OUT)
  ws.close(); child.kill(); server.close(); await sleep(300)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
  process.exit(0)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
