// 用本地静态服务 + headless Edge 把桌宠真跑一遍，截图并检查交互。
// 跑：node test/visual-check.mjs <输出png>
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const ASSETS = path.join(PLUGIN, 'assets', 'cow')
const PET_JS = path.join(PLUGIN, 'lib', 'pet.js')
const OUT = process.argv[2] || path.join(os.tmpdir(), 'cow-pet.png')
const PORT = 7791
const DEVTOOLS = 9455
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:radial-gradient(120% 90% at 30% 10%,#1b2230,#0d1017 70%);}
  .fake-app{position:absolute;inset:0;font:14px/1.6 system-ui;color:#8d97a8;padding:24px}
  .fake-app h1{font:600 22px system-ui;color:#dfe6f2;margin:0 0 8px}
</style></head><body>
  <div class="fake-app"><h1>DSH · 桌宠试衣间</h1><p>这里模拟主界面背景，验证玻璃牛挂在右下角的样子。</p></div>
  <script src="/dsh-cow-pet/pet.js"></script>
</body></html>`

const POSTS = []
const MOODS = path.join(PLUGIN, 'assets', 'mood')
let CURRENT = { phase: 'idle', since: Date.now() }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  if (url.pathname === '/dsh-cow-pet/pet.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
    res.end(fs.readFileSync(PET_JS))
    return
  }
  if (url.pathname === '/dsh-cow-pet/state.json') {
    const sprites = fs.readdirSync(ASSETS).filter((f) => f.endsWith('.png')).map((f) => f.replace('.png', ''))
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        POSTS.push(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, state: JSON.parse(body || '{}') }))
      })
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, state: { enabled: true, size: 132, startupShown: false }, sprites }))
    return
  }
  if (url.pathname === '/dsh-cow-pet/phase.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, phase: CURRENT.phase, since: CURRENT.since, events: CURRENT.events || [] }))
    return
  }
  if (url.pathname.startsWith('/dsh-cow-pet/mood/')) {
    const name = path.basename(url.pathname)
    try {
      const buf = fs.readFileSync(path.join(MOODS, name))
      const type = name.endsWith('.webp') ? 'image/webp' : name.endsWith('.png') ? 'image/png' : 'image/jpeg'
      res.writeHead(200, { 'Content-Type': type })
      res.end(buf)
    } catch {
      res.writeHead(404).end()
    }
    return
  }
  if (url.pathname === '/dsh-cow-pet/startup.webp') {
    const buf = fs.readFileSync(path.join(PLUGIN, 'assets', 'startup', 'startup.webp'))
    res.writeHead(200, { 'Content-Type': 'image/webp' })
    res.end(buf)
    return
  }
  const m = url.pathname.match(/^\/dsh-cow-pet\/asset\/(\w+)\.png$/)
  if (m) {
    try {
      const buf = fs.readFileSync(path.join(ASSETS, m[1] + '.png'))
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(buf)
    } catch {
      res.writeHead(404).end()
    }
    return
  }
  res.writeHead(404).end()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-cow-'))
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--allow-file-access-from-files',
      `--remote-debugging-port=${DEVTOOLS}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=900,620',
      `http://127.0.0.1:${PORT}/`,
    ],
    { stdio: 'ignore' },
  )

  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json`)).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch {}
    if (!target) await sleep(250)
  }
  if (!target) throw new Error('devtools 没起来')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r.result.value
  }

  await send('Page.enable')
  await send('Runtime.enable')
  // 等桌宠把图片加载完
  await sleep(1400)

  const info = await evaluate(`(() => {
    const root = document.querySelector('.dsh-cow-pet')
    if (!root) return JSON.stringify({ mounted: false })
    const img = root.querySelector('img')
    const r = root.getBoundingClientRect()
    return JSON.stringify({
      mounted: true,
      cls: root.className,
      mood: img.getAttribute('data-mood'),
      natural: [img.naturalWidth, img.naturalHeight],
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      pos: root.style.transform,
      bubble: !!root.querySelector('.dsh-cow-pet-bubble'),
    })
  })()`)
  console.log('MOUNT', info)

  const splash = await evaluate(`(() => {
    const s = document.querySelector('.dsh-cow-pet-card')
    if (!s) return JSON.stringify({ splash: false })
    const img = s.querySelector('img')
    const card = s.getBoundingClientRect()
    return JSON.stringify({
      splash: true,
      src: img && img.getAttribute('src'),
      loaded: img ? img.complete && img.naturalWidth > 0 : false,
      natural: img ? [img.naturalWidth, img.naturalHeight] : null,
      card: [Math.round(card.x), Math.round(card.y), Math.round(card.width), Math.round(card.height)],
      pet: (() => { const p = document.querySelector('.dsh-cow-pet').getBoundingClientRect(); return [Math.round(p.x), Math.round(p.y), Math.round(p.width), Math.round(p.height)] })(),
      btn: s.querySelector('.dsh-cow-pet-card-btn')?.textContent,
    })
  })()`)
  console.log('SPLASH', splash)

  const shot0 = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(OUT.replace(/\.png$/, '-splash.png'), Buffer.from(shot0.data, 'base64'))

  await evaluate(`(() => { document.querySelector('.dsh-cow-pet-card-btn')?.click(); return 'clicked' })()`)
  await sleep(500)
  const afterClose = await evaluate(`JSON.stringify({
    splashGone: !document.querySelector('.dsh-cow-pet-card'),
    petAlive: !!document.querySelector('.dsh-cow-pet'),
  })`)
  console.log('SPLASH_CLOSE', afterClose, 'POSTS', JSON.stringify(POSTS))

  // ---- 三种时机：思考中 / 等权限 / 干完 ----
  async function setPhase(name, wait, tag) {
    CURRENT = { phase: name, since: Date.now() }
    await sleep(wait)
    const info = await evaluate(`(() => {
      const s = document.querySelector('.dsh-cow-pet-shot')
      const img = s && s.querySelector('img')
      const r = s && s.getBoundingClientRect()
      const p = document.querySelector('.dsh-cow-pet').getBoundingClientRect()
      const b = document.querySelector('.dsh-cow-pet-bubble')
      return JSON.stringify({
        shot: !!s,
        src: img ? img.getAttribute('src') : null,
        loaded: img ? img.complete && img.naturalWidth > 0 : false,
        box: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
        pet: [Math.round(p.x), Math.round(p.y), Math.round(p.width), Math.round(p.height)],
        tail: s ? getComputedStyle(s, '::after').left : null,
        bubble: b ? b.textContent : null,
      })
    })()`)
    console.log(tag, info)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(OUT.replace(/\.png$/, tag.toLowerCase().replace(/[^a-z]/g, '') + '.png'), Buffer.from(shot.data, 'base64'))
  }

  await setPhase('thinking', 2400, 'PHASE_THINK')
  await setPhase('waiting', 2400, 'PHASE_WAIT')
  await setPhase('done', 2000, 'PHASE_DONE')
  CURRENT = { phase: 'idle', since: Date.now() }
  await sleep(2000)
  const cleaned = await evaluate(`JSON.stringify({ shot: !!document.querySelector('.dsh-cow-pet-shot') })`)
  console.log('PHASE_IDLE', cleaned)

  // 权限配对：只看到 asked → 等权限；asked 之后又有 decided → 立刻回到思考
  CURRENT = { phase: 'waiting', since: Date.now(), events: ['turn/start', 'approval/asked'] }
  await sleep(2000)
  console.log('PAIR_ASKED', await evaluate(`JSON.stringify({ shot: !!document.querySelector('.dsh-cow-pet-shot'), src: document.querySelector('.dsh-cow-pet-shot img')?.getAttribute('src') })`))

  CURRENT = { phase: 'waiting', since: Date.now(), events: ['turn/start', 'approval/asked', 'approval/decided'] }
  await sleep(2200)
  console.log('PAIR_DECIDED', await evaluate(`JSON.stringify({ shot: !!document.querySelector('.dsh-cow-pet-shot'), src: document.querySelector('.dsh-cow-pet-shot img')?.getAttribute('src') })`))

  const shot1 = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(OUT, Buffer.from(shot1.data, 'base64'))
  console.log('SHOT1', OUT, fs.statSync(OUT).size)

  // 戳一下：应该换表情并冒出气泡
  const poked = await evaluate(`(() => {
    const root = document.querySelector('.dsh-cow-pet')
    const r = root.getBoundingClientRect()
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2
    const opts = { bubbles: true, clientX: cx, clientY: cy, pointerId: 1, button: 0, isPrimary: true }
    root.dispatchEvent(new PointerEvent('pointerdown', opts))
    root.dispatchEvent(new PointerEvent('pointerup', opts))
    return 'ok'
  })()`)
  await sleep(320)
  const after = await evaluate(`(() => {
    const root = document.querySelector('.dsh-cow-pet')
    const b = root.querySelector('.dsh-cow-pet-bubble')
    return JSON.stringify({ cls: root.className, mood: root.querySelector('img').getAttribute('data-mood'), bubble: b.textContent, show: b.classList.contains('show') })
  })()`)
  console.log('POKE', poked, after)

  const shot2 = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(OUT.replace(/\.png$/, '-poke.png'), Buffer.from(shot2.data, 'base64'))

  // 拖一下：位置应该变，并且发出 POST
  const drag = await evaluate(`(async () => {
    const root = document.querySelector('.dsh-cow-pet')
    const before = root.style.transform
    const r = root.getBoundingClientRect()
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2
    const mk = (type, x, y) => new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 2, button: 0, isPrimary: true })
    root.dispatchEvent(mk('pointerdown', cx, cy))
    root.dispatchEvent(mk('pointermove', cx - 40, cy - 30))
    root.dispatchEvent(mk('pointermove', cx - 160, cy - 120))
    root.dispatchEvent(mk('pointerup', cx - 160, cy - 120))
    await new Promise(r => setTimeout(r, 200))
    return JSON.stringify({ before, after: root.style.transform })
  })()`)
  console.log('DRAG', drag)
  const posted = await evaluate(`window.__posted === undefined ? 'n/a' : JSON.stringify(window.__posted)`)
  console.log('POSTED', posted)

  const shot3 = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(OUT.replace(/\.png$/, '-drag.png'), Buffer.from(shot3.data, 'base64'))

  // ---- 右键设置面板：大小 / 气泡 / 思考频率 ----
  const opened = await evaluate(`(() => {
    const r = document.querySelector('.dsh-cow-pet')
    const b = r.getBoundingClientRect()
    r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 }))
    return JSON.stringify({
      open: !!document.querySelector('.dsh-cow-pet-settings'),
      rows: document.querySelectorAll('.dsh-cow-pet-settings input[type=range]').length,
    })
  })()`)
  await sleep(320)
  console.log('SETTINGS_OPEN', opened)

  const applied = await evaluate(`(() => {
    const inputs = document.querySelectorAll('.dsh-cow-pet-settings input[type=range]')
    const set = (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    set(inputs[0], 150)
    set(inputs[1], 130)
    set(inputs[2], 200)
    return JSON.stringify([...inputs].map((i) => i.value))
  })()`)
  await sleep(900)
  const measured = await evaluate(`(() => {
    const r = document.querySelector('.dsh-cow-pet')
    const box = r.getBoundingClientRect()
    const panel = document.querySelector('.dsh-cow-pet-settings')
    return JSON.stringify({
      box: [Math.round(box.width), Math.round(box.height)],
      sizeVar: r.style.getPropertyValue('--size'),
      bubbleVar: r.style.getPropertyValue('--bubble-scale'),
      labels: [...document.querySelectorAll('.dsh-cow-pet-val')].map((n) => n.textContent),
      panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : null,
    })
  })()`)
  console.log('SETTINGS_APPLIED', applied, measured, 'POSTS', JSON.stringify(POSTS.slice(-2)))

  const shotS = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(OUT.replace(/\.png$/, '-settings.png'), Buffer.from(shotS.data, 'base64'))

  // 点别处应该收掉面板
  await evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
  await sleep(500)
  console.log('SETTINGS_CLOSE', await evaluate(`JSON.stringify({ gone: !document.querySelector('.dsh-cow-pet-settings') })`))

  ws.close()
  child.kill()
  server.close()
  await sleep(400)
  try {
    fs.rmSync(profile, { recursive: true, force: true })
  } catch {
    // Edge 还攥着 profile 目录，删不掉就算了，临时目录会被系统清
  }
  console.log('DONE')
}

main().catch((err) => {
  console.error('FAILED', err.message)
  process.exitCode = 1
  try {
    server.close()
  } catch {}
})
