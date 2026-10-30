// dsh-cow-pet 的离线自检：用一个假的 cordis root 跑一遍 apply()，
// 再把注册出来的 handler 当普通函数调用，检查返回内容。
// 跑：node test/plugin-check.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cow-pet-'))
process.env.DSH_HOME = tempHome

const { default: plugin } = await import('../lib/index.js')

const routes = []
const table = []
const tapped = []

const root = {
  on(event, cb) {
    if (event === 'webserver/index-inject') cb(table)
  },
  inject(_deps, fn) {
    fn({
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
        tapIndex(cb) {
          tapped.push(cb)
        },
      },
      on() {
        return () => {}
      },
    })
  },
}

plugin.apply(root)

function routeFor(p) {
  const r = routes.find((x) => x.path === p)
  assert.ok(r, 'route missing: ' + p)
  return r
}

function fakeReq({ url = '/', method = 'GET', host = '127.0.0.1:64083', body = null, secFetchSite = 'same-origin' } = {}) {
  const listeners = {}
  const req = {
    url,
    method,
    headers: { host, 'sec-fetch-site': secFetchSite },
    on(ev, cb) {
      listeners[ev] = cb
      return req
    },
    destroy() {},
  }
  if (body !== null) {
    setTimeout(() => {
      listeners.data?.(Buffer.from(body))
      listeners.end?.()
    }, 0)
  }
  return req
}

function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers || {}
    },
    end(chunk) {
      res.body = chunk
    },
  }
  return res
}

async function call(route, options) {
  const req = fakeReq(options)
  const res = fakeRes()
  await route.handler(req, res)
  return res
}

// 1. 注入行
assert.equal(table.length, 1, '应该只注入一行')
assert.ok(table[0].text.includes('/dsh-cow-pet/pet.js'), '注入行要指向 pet.js')
assert.equal(table[0].placement, 'body')

// 2. 路由数量：pet.js + state.json + poke + 7 张素材
const assets = routes.filter((r) => r.path.startsWith('/dsh-cow-pet/asset/'))
assert.equal(assets.length, 6, '素材路由应有 6 条，实际 ' + assets.length)
assert.ok(routeFor('/dsh-cow-pet/pet.js'))
assert.ok(routeFor('/dsh-cow-pet/state.json'))
assert.ok(routeFor('/dsh-cow-pet/poke'))
assert.ok(routeFor('/dsh-cow-pet/startup.webp'))
assert.ok(routeFor('/dsh-cow-pet/phase.json'), 'phase 路由缺失')

const moods = routes.filter((r) => r.path.startsWith('/dsh-cow-pet/mood/'))
assert.equal(moods.length, 6, '表情图路由应有 6 条，实际 ' + moods.length)
for (const f of ['1.jpg', 'niusi.jpg', '2.jpg', '4.jpg', '5.jpg', '7.webp']) {
  const r = routes.find((x) => x.path === '/dsh-cow-pet/mood/' + f)
  assert.ok(r, '缺少表情图路由：' + f)
}

// 3. pet.js 能取到且是 JS
{
  const res = await call(routeFor('/dsh-cow-pet/pet.js'), { url: '/dsh-cow-pet/pet.js' })
  assert.equal(res.status, 200)
  assert.match(res.headers['Content-Type'], /javascript/)
  assert.ok(String(res.body).includes('dshCowPet'))
}

// 4. state.json：GET 返回 7 个表情
{
  const res = await call(routeFor('/dsh-cow-pet/state.json'), { url: '/dsh-cow-pet/state.json' })
  assert.equal(res.status, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.equal(data.sprites.length, 6, 'sprites 应为 6，实际 ' + data.sprites.length)
  assert.deepEqual(data.sprites.sort(), ['cry', 'oops', 'ride', 'smug', 'think', 'walk'])
  assert.equal(data.state.startupShown, false)
  assert.equal(data.state.enabled, true)
}

// 5. POST 保存位置 → 落盘
{
  const res = await call(routeFor('/dsh-cow-pet/state.json'), {
    url: '/dsh-cow-pet/state.json',
    method: 'POST',
    body: JSON.stringify({ x: 640, y: 320, size: 150, sleeping: true, junk: 'should be dropped' }),
  })
  assert.equal(res.status, 200)
  const saved = JSON.parse(res.body).state
  assert.equal(saved.x, 640)
  assert.equal(saved.size, 150)
  assert.equal(saved.sleeping, true)
  assert.equal('junk' in saved, false, '不认识的字段要丢掉')

  const onDisk = JSON.parse(fs.readFileSync(path.join(tempHome, 'dsh-cow-pet', 'state.json'), 'utf8'))
  assert.equal(onDisk.x, 640)
  assert.equal(onDisk.sleeping, true)
}

// 6. 尺寸类字段会被夹到各自区间
{
  const res = await call(routeFor('/dsh-cow-pet/state.json'), {
    url: '/dsh-cow-pet/state.json',
    method: 'POST',
    body: JSON.stringify({ size: 9999 }),
  })
  assert.equal(JSON.parse(res.body).state.size, 320)
}

// 6b. 右键设置的三项：百分比 / 秒
{
  const res = await call(routeFor('/dsh-cow-pet/state.json'), {
    url: '/dsh-cow-pet/state.json',
    method: 'POST',
    body: JSON.stringify({ scale: 900, bubbleScale: 1, thinkInterval: 999 }),
  })
  const st = JSON.parse(res.body).state
  assert.equal(st.scale, 200, 'scale 上限 200')
  assert.equal(st.bubbleScale, 60, 'bubbleScale 下限 60')
  assert.equal(st.thinkInterval, 60, 'thinkInterval 上限 60')

  const low = JSON.parse(
    (
      await call(routeFor('/dsh-cow-pet/state.json'), {
        url: '/dsh-cow-pet/state.json',
        method: 'POST',
        body: JSON.stringify({ scale: 1, bubbleScale: 999, thinkInterval: 0 }),
      })
    ).body,
  ).state
  assert.equal(low.scale, 50, 'scale 下限 50')
  assert.equal(low.bubbleScale, 220, 'bubbleScale 上限 220')
  assert.equal(low.thinkInterval, 2, 'thinkInterval 下限 2')
}

// 7. 非法 JSON → 400
{
  const res = await call(routeFor('/dsh-cow-pet/state.json'), {
    url: '/dsh-cow-pet/state.json',
    method: 'POST',
    body: 'not json',
  })
  assert.equal(res.status, 400)
}

// 8. 非回环 Host → 403
{
  const res = await call(routeFor('/dsh-cow-pet/state.json'), {
    url: '/dsh-cow-pet/state.json',
    host: 'evil.example.com',
  })
  assert.equal(res.status, 403)
}

// 9. 素材返回真 PNG
{
  const res = await call(routeFor('/dsh-cow-pet/asset/walk.png'), { url: '/dsh-cow-pet/asset/walk.png' })
  assert.equal(res.status, 200)
  assert.equal(res.headers['Content-Type'], 'image/png')
  const sig = Buffer.from(res.body).subarray(0, 8)
  assert.deepEqual([...sig], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 魔数不对')
}

// 9.5 开机图：原样 webp，且 startupShown 能落盘
{
  const res = await call(routeFor('/dsh-cow-pet/startup.webp'), { url: '/dsh-cow-pet/startup.webp' })
  assert.equal(res.status, 200)
  assert.equal(res.headers['Content-Type'], 'image/webp')
  assert.ok(Buffer.from(res.body).length > 1000)
}

// 10. Web 端 tapIndex 注入
{
  assert.equal(tapped.length, 1)
  const html = tapped[0]('<html><body></body></html>')
  assert.ok(html.includes('/dsh-cow-pet/pet.js'))
  assert.equal(tapped[0](html), html, '重复注入应幂等')
}

fs.rmSync(tempHome, { recursive: true, force: true })
console.log('ALL PASS · routes=' + routes.length + ' assets=' + assets.length + ' sprites=6')
