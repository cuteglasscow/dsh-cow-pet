// dsh-cow-pet —— host 侧
// 路由：
//   GET  /dsh-cow-pet/pet.js          浏览器里的桌宠脚本
//   GET  /dsh-cow-pet/state.json      桌宠状态（位置、开关、当前心情）
//   POST /dsh-cow-pet/state.json      保存状态（拖动结束后回写）
//   GET  /dsh-cow-pet/poke?text=…     让牛说一句话（预留给别的插件调用）
//   GET  /dsh-cow-pet/asset/<n>.png   抠好的表情素材
// 注入：桌面端走 webserver/index-inject（Electron 唯一通道），Web 端再补一份 tapIndex。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const PET_JS = path.join(HERE, 'pet.js')
const ASSET_DIR = path.join(ROOT, 'assets', 'cow')
const MOOD_DIR = path.join(ROOT, 'assets', 'mood')

const BASE = '/dsh-cow-pet'
const PET_PATH = BASE + '/pet.js'
const STATE_PATH = BASE + '/state.json'
const POKE_PATH = BASE + '/poke'
const ASSET_PREFIX = BASE + '/asset/'
// 开机那张「牛来！」：直接用原图，不抠
const STARTUP_PATH = BASE + '/startup.webp'
const STARTUP_FILE = path.join(ROOT, 'assets', 'startup', 'startup.webp')
// 思考 / 等权限 / 干完 三种时机的表情图
const MOOD_PREFIX = BASE + '/mood/'
const PHASE_PATH = BASE + '/phase.json'

const PET_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="' + PET_PATH + '";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

// 表情 → 台词。客户端也有一份，这里留着给 poke 兜底用。
const LINES = {
  think: ['头好痒，好像要长脑子了', '让我想想……', '这题超纲了'],
  cry: ['都在欺负萌萌的我', '呜呜呜', '别戳了别戳了'],
  smug: ['就这？', '早说了吧', '让我看看是谁在偷懒'],
  ride: ['牛气冲天！', '出发！', '驾！'],
  walk: ['哞~', '今天也要加油', '散步中'],
  oops: ['哞的天', '啊这', '坏了'],
}

const SPRITES = ['think', 'cry', 'smug', 'ride', 'walk', 'oops']

// ---------- 状态：放 DSH_HOME 下，不污染插件目录 ----------
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function stateFile() {
  return path.join(dshHome(), 'dsh-cow-pet', 'state.json')
}

const DEFAULT_STATE = {
  enabled: true,
  x: null, // null = 用默认位置（右下角）
  y: null,
  size: 132,
  // 右键设置面板里的三项（百分比 / 秒）
  scale: 100, // 桌宠大小，100 = 132px
  bubbleScale: 100, // 气泡与图片气泡大小
  thinkInterval: 7, // 思考中每多少秒换一张图
  sleeping: false,
  // 开机那张「牛来！」只在第一次启动时弹一次
  startupShown: false,
  updatedAt: null,
}

let memoryState = { ...DEFAULT_STATE }

function readState() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...memoryState }
    const next = { ...DEFAULT_STATE, ...parsed }
    memoryState = next
    return next
  } catch {
    return { ...memoryState }
  }
}

function writeState(patch) {
  const next = { ...readState(), ...(patch || {}), updatedAt: new Date().toISOString() }
  // 只接受认识的字段，别让浏览器往文件里塞任意 JSON
  const clean = {
    enabled: next.enabled !== false,
    x: Number.isFinite(next.x) ? Math.round(next.x) : null,
    y: Number.isFinite(next.y) ? Math.round(next.y) : null,
    size: Number.isFinite(next.size) ? Math.min(320, Math.max(40, Math.round(next.size))) : DEFAULT_STATE.size,
    scale: Number.isFinite(next.scale) ? Math.min(200, Math.max(50, Math.round(next.scale))) : DEFAULT_STATE.scale,
    bubbleScale: Number.isFinite(next.bubbleScale)
      ? Math.min(220, Math.max(60, Math.round(next.bubbleScale)))
      : DEFAULT_STATE.bubbleScale,
    thinkInterval: Number.isFinite(next.thinkInterval)
      ? Math.min(60, Math.max(2, Math.round(next.thinkInterval)))
      : DEFAULT_STATE.thinkInterval,
    sleeping: next.sleeping === true,
    startupShown: next.startupShown === true,
    updatedAt: next.updatedAt,
  }
  memoryState = clean
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
    fs.writeFileSync(stateFile(), JSON.stringify(clean, null, 2), 'utf8')
  } catch {}
  return clean
}

// ---------- HTTP 辅助 ----------
function loopbackHost(hostHeader) {
  try {
    const u = new URL('http://' + String(hostHeader || ''))
    const h = u.hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost')
  } catch {
    return false
  }
}

function reject(req) {
  const headers = (req && req.headers) || {}
  if (!loopbackHost(headers.host)) return 403
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
  const origin = headers.origin
  if (typeof origin === 'string' && origin && origin !== 'null') {
    try {
      if (new URL(origin).host.toLowerCase() !== new URL('http://' + headers.host).host.toLowerCase()) return 403
    } catch {
      return 403
    }
  }
  return null
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        resolve('')
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function listSprites() {
  try {
    return fs
      .readdirSync(ASSET_DIR)
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .map((f) => f.replace(/\.png$/i, ''))
  } catch {
    return []
  }
}

function listMood() {
  try {
    return fs
      .readdirSync(MOOD_DIR)
      .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort()
  } catch {
    return []
  }
}

function moodType(file) {
  if (/\.png$/i.test(file)) return 'image/png'
  if (/\.webp$/i.test(file)) return 'image/webp'
  return 'image/jpeg'
}

// ---------- 会话阶段：思考中 / 等权限 / 干完 ----------
// 只读 session/event，不改任何东西；事件名用模式匹配，宿主改名字也不至于全废。
const phaseState = {
  value: 'idle', // idle | thinking | waiting | done
  since: Date.now(),
  lastAt: 0,
  lastType: '',
  events: [],
}
const EVENT_KEEP = 40
const THINK_QUIET_MS = 45000
const DONE_HOLD_MS = 8000

function noteSessionEvent(session, event) {
  const type = event && typeof event.type === 'string' ? event.type : ''
  if (!type) return
  const at = Date.now()
  phaseState.lastAt = at
  phaseState.lastType = type
  phaseState.events.push({ type, at })
  if (phaseState.events.length > EVENT_KEEP) phaseState.events.shift()

  const key = type.toLowerCase()
  let next = null
  if (/approval\/(decided|resolved|rejected|granted)|approval\/(granted|denied)/.test(key)) next = 'thinking'
  else if (/approval\/asked|approval\/requ|permission\/requ|confirm|question|authoriz|\bask\b|user-input/.test(key)) next = 'waiting'
  else if (/turn\/end|turn\/error|cancel|abort|finish/.test(key)) next = 'done'
  else if (/start|message|step|tool|think|run|delta|stream|reason/.test(key)) next = 'thinking'

  if (next && next !== phaseState.value) {
    phaseState.value = next
    phaseState.since = at
  }
}

function currentPhase() {
  const now = Date.now()
  let value = phaseState.value
  if (value === 'thinking' && phaseState.lastAt && now - phaseState.lastAt > THINK_QUIET_MS) value = 'idle'
  if (value === 'done' && now - phaseState.since > DONE_HOLD_MS) value = 'idle'
  if (value === 'waiting' && phaseState.lastAt && now - phaseState.lastAt > 10 * 60 * 1000) value = 'idle'
  return {
    ok: true,
    phase: value,
    at: now,
    since: value === phaseState.value ? phaseState.since : now,
    lastType: phaseState.lastType,
    lastAt: phaseState.lastAt,
    events: phaseState.events.slice(-12).map((e) => e.type),
  }
}

export default {
  name: 'dsh-cow-pet',
  apply(root) {
    // ① 注入行：桌面端在宿主启动时一次性收集这张表，必须在 apply 的第一时间挂上
    try {
      root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          if (table.some((row) => row && typeof row.text === 'string' && row.text.includes(PET_PATH))) return
          table.push({ kind: 'script', placement: 'body', text: PET_ROW_TEXT })
        } catch {}
      })
    } catch {}

    // ② 路由
    root.inject(['webServer'], (ctx) => {
      const disposers = []

      try {
        disposers.push(
          ctx.on('session/event', (session, event) => {
            try {
              noteSessionEvent(session, event)
            } catch {}
          }),
        )
      } catch {}

      const register = (route) => {
        const inner = route.handler
        disposers.push(
          ctx.webServer.register({
            ...route,
            handler: (req, res) => {
              const code = reject(req)
              if (code) {
                res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end(String(code))
                return
              }
              return inner(req, res)
            },
          }),
        )
      }

      register({
        kind: 'exact',
        path: PET_PATH,
        handler: (req, res) => {
          try {
            const text = fs.readFileSync(PET_JS, 'utf8')
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
              'Content-Length': String(Buffer.byteLength(text)),
            })
            res.end(text)
          } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('pet.js unavailable')
          }
        },
      })

      register({
        kind: 'exact',
        path: STATE_PATH,
        handler: async (req, res) => {
          const method = (req.method || 'GET').toUpperCase()
          if (method === 'POST') {
            const raw = await readBody(req)
            let patch = null
            try {
              patch = JSON.parse(raw)
            } catch {
              patch = null
            }
            if (!patch || typeof patch !== 'object') {
              sendJson(res, 400, { ok: false, error: 'body must be a JSON object' })
              return
            }
            const saved = writeState(patch)
            sendJson(res, 200, { ok: true, state: saved })
            return
          }
          sendJson(res, 200, {
            ok: true,
            state: readState(),
            sprites: listSprites(),
            expected: SPRITES,
            lines: LINES,
          })
        },
      })

      register({
        kind: 'exact',
        path: POKE_PATH,
        handler: (req, res) => {
          const url = new URL(req.url || '/', 'http://localhost')
          const text = (url.searchParams.get('text') || '').slice(0, 120)
          const mood = (url.searchParams.get('mood') || '').slice(0, 24)
          sendJson(res, 200, { ok: true, text, mood: SPRITES.indexOf(mood) === -1 ? null : mood, at: Date.now() })
        },
      })

      // 开机图：原样的 6.webp，不抠不改，只在第一次启动时给前端弹一次
      register({
        kind: 'exact',
        path: STARTUP_PATH,
        handler: (req, res) => {
          try {
            const buf = fs.readFileSync(STARTUP_FILE)
            res.writeHead(200, {
              'Content-Type': 'image/webp',
              'Cache-Control': 'public, max-age=86400',
              'Content-Length': String(buf.length),
            })
            res.end(buf)
          } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('startup image unavailable')
          }
        },
      })

      // 阶段轮询：给客户端判断气泡该弹什么图
      register({
        kind: 'exact',
        path: PHASE_PATH,
        handler: (req, res) => {
          sendJson(res, 200, currentPhase())
        },
      })

      // 思考 / 等权限 / 干完 用的表情图：同样逐张精确注册
      try {
        for (const file of listMood()) {
          register({
            kind: 'exact',
            path: MOOD_PREFIX + file,
            handler: (req, res) => {
              try {
                const buf = fs.readFileSync(path.join(MOOD_DIR, file))
                res.writeHead(200, {
                  'Content-Type': moodType(file),
                  'Cache-Control': 'public, max-age=86400',
                  'Content-Length': String(buf.length),
                })
                res.end(buf)
              } catch {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('mood image unavailable')
              }
            },
          })
        }
      } catch {}

      // 素材：逐个精确路由，避免前缀匹配把别的东西也接走
      try {
        for (const name of listSprites()) {
          register({
            kind: 'exact',
            path: ASSET_PREFIX + name + '.png',
            handler: (req, res) => {
              try {
                const buf = fs.readFileSync(path.join(ASSET_DIR, name + '.png'))
                res.writeHead(200, {
                  'Content-Type': 'image/png',
                  'Cache-Control': 'public, max-age=86400',
                  'Content-Length': String(buf.length),
                })
                res.end(buf)
              } catch {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('sprite unavailable')
              }
            },
          })
        }
      } catch {}

      // Web 端补一份（Electron 桌面端用不到，但 PWA 场景需要）
      try {
        ctx.webServer.tapIndex?.((html) => {
          if (html.includes(PET_PATH)) return html
          const tag = '<script defer src="' + PET_PATH + '"></script>'
          return html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag
        })
      } catch {}

      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {}
        }
      }
    })
  },
}
