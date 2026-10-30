// dsh-cow-pet —— 浏览器侧
// 一个悬浮在角落的玻璃牛：会呼吸、会乱换表情、能拖走、戳一下会说话。
// 不依赖任何框架，也不假设宿主 DOM 结构（只往 body 上挂自己的一棵树）。
;(function () {
  if (window.__dshCowPet) return
  window.__dshCowPet = true

  var BASE = '/dsh-cow-pet'
  var STATE_URL = BASE + '/state.json'
  var ASSET = BASE + '/asset/'

  var DEFAULTS = {
    enabled: true,
    x: null,
    y: null,
    size: 132,
    scale: 100,
    bubbleScale: 100,
    thinkInterval: 7,
    sleeping: false,
  }

  var BASE_SIZE = 132
  var BASE_THINK = 7

  // 只显示这一张（3.jpg 抠出来的「推眼镜」），不轮换
  var SPRITE = 'smug'

  var CHAT = [
    '哞~',
    '今天也要好好干活',
    '有事叫我',
    '别戳啦，痒',
    '我在看着你',
    '摸鱼被抓到了？',
    '要喝口水吗',
    '这活儿不急',
  ]

  var state = Object.assign({}, DEFAULTS)
  var root = null
  var img = null
  var bubble = null
  var idleTimer = null
  var busy = false
  var bubbleTimer = null
  var dragging = false
  var moved = false
  var startX = 0
  var startY = 0

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)]
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n))
  }

  function save(patch) {
    try {
      fetch(STATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(function () {})
    } catch (e) {}
  }

  function say(text) {
    if (!bubble || !text) return
    bubble.textContent = text
    bubble.classList.add('show')
    clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(function () {
      bubble.classList.remove('show')
    }, 2600)
  }

  // 固定一张图：只有第一次挂载时设 src，之后不再动
  function applySprite() {
    if (!img) return
    var next = ASSET + SPRITE + '.png'
    if (img.getAttribute('data-mood') === SPRITE) return
    img.setAttribute('data-mood', SPRITE)
    img.src = next
  }

  function scheduleIdle() {
    // 图固定了，闲时不再换表情；这里只把计时器清掉
    clearTimeout(idleTimer)
  }

  // ---------- 跟着干活状态跑（有 dsh-balance-card 就用，没有就算了） ----------
  function watchActivity() {
    var wasBusy = false
    function tick() {
      fetch('/dsh-balance/turn.json', { headers: { Accept: 'application/json' } })
        .then(function (r) {
          return r.json()
        })
        .then(function (data) {
          var live = !!(data && data.live)
          if (live === wasBusy) return
          wasBusy = live
          busy = live
          if (state.sleeping || !root) return
          if (live) {
            if (Math.random() < 0.5) say('冲鸭')
          } else {
            say('干完啦')
          }
        })
        .catch(function () {})
        .then(function () {
          setTimeout(tick, 4000)
        })
    }
    setTimeout(tick, 1200)
  }

  // ---------- 位置 ----------
  function homePos(size) {
    return {
      x: Math.max(12, window.innerWidth - size - 28),
      y: Math.max(12, window.innerHeight - size - 40),
    }
  }

  function petSize() {
    var pct = clamp(Number(state.scale) || 100, 50, 200)
    return Math.round((BASE_SIZE * pct) / 100)
  }

  function applyScale(keepInView) {
    if (!root) return
    var size = petSize()
    state.size = size
    var bub = clamp(Number(state.bubbleScale) || 100, 60, 220)
    root.style.setProperty('--size', size + 'px')
    root.style.setProperty('--bubble-scale', String(bub / 100))
    if (keepInView) {
      // 变大之后原来贴着屏幕底的那只脚会跑到画外，往上提一点
      var x = Number.isFinite(state.x) ? state.x : homePos(size).x
      var y = Number.isFinite(state.y) ? state.y : homePos(size).y
      var ny = Math.min(y, window.innerHeight - size - 6)
      var nx = Math.min(x, window.innerWidth - size - 6)
      if (ny !== y || nx !== x) {
        state.x = Math.max(6, Math.round(nx))
        state.y = Math.max(6, Math.round(ny))
        save({ x: state.x, y: state.y })
      }
    }
  }

  function applyPosition() {
    if (!root) return
    var size = petSize()
    var pos = homePos(size)
    var x = Number.isFinite(state.x) ? state.x : pos.x
    var y = Number.isFinite(state.y) ? state.y : pos.y
    x = clamp(x, -size * 0.3, window.innerWidth - size * 0.7)
    y = clamp(y, 0, window.innerHeight - size * 0.55)
    root.style.setProperty('--size', size + 'px')
    root.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)'
    bubble.classList.toggle('left', x > window.innerWidth * 0.55)
  }

  function applySleeping() {
    if (!root) return
    root.classList.toggle('sleeping', !!state.sleeping)
    if (state.sleeping) {
      clearTimeout(idleTimer)
      if (bubble) bubble.classList.remove('show')
    } else {
      scheduleIdle()
    }
  }

  // ---------- 拖动 ----------
  function onDown(ev) {
    if (ev.button !== undefined && ev.button !== 0) return
    dragging = true
    moved = false
    startX = ev.clientX
    startY = ev.clientY
    try {
      root.setPointerCapture(ev.pointerId)
    } catch (e) {}
    root.classList.add('grabbing')
  }

  function onMove(ev) {
    if (!dragging) return
    var dx = ev.clientX - startX
    var dy = ev.clientY - startY
    if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return
    moved = true
    var size = state.size
    var base = { x: Number.isFinite(state.x) ? state.x : homePos(size).x, y: Number.isFinite(state.y) ? state.y : homePos(size).y }
    state.x = base.x + dx
    state.y = base.y + dy
    startX = ev.clientX
    startY = ev.clientY
    applyPosition()
  }

  function onUp(ev) {
    if (!dragging) return
    dragging = false
    root.classList.remove('grabbing')
    try {
      root.releasePointerCapture(ev.pointerId)
    } catch (e) {}
    if (moved) {
      save({ x: Math.round(state.x), y: Math.round(state.y) })
    } else {
      poke()
    }
  }

  function poke() {
    if (cardOpen) return // 气泡开着时先让它关，别同一戳两用
    if (state.sleeping) {
      state.sleeping = false
      applySleeping()
      save({ sleeping: false })
      say('醒啦，我还想睡')
      return
    }
    say(pick(CHAT))
    // 戳完让身子晃一下
    root.classList.remove('bounce')
    void root.offsetWidth
    root.classList.add('bounce')
    scheduleIdle()
  }

  function onDblClick(ev) {
    ev.preventDefault()
    state.sleeping = !state.sleeping
    applySleeping()
    save({ sleeping: state.sleeping })
    if (!state.sleeping) say('我醒了')
  }

  // ---------- 构建 DOM ----------
  function build(sprites) {
    if (!sprites.length) return
    root = document.createElement('div')
    root.className = 'dsh-cow-pet'
    root.setAttribute('role', 'img')
    root.setAttribute('aria-label', '玻璃牛桌宠')

    bubble = document.createElement('div')
    bubble.className = 'dsh-cow-pet-bubble'

    img = document.createElement('img')
    img.className = 'dsh-cow-pet-img'
    img.alt = ''
    img.draggable = false
    applySprite()
    img.addEventListener('load', function () {
      root.classList.add('ready')
    })
    img.addEventListener('error', function () {
      // 素材缺失就自己消失，别在界面上留个破图
      root.classList.add('broken')
    })

    var shadow = document.createElement('div')
    shadow.className = 'dsh-cow-pet-shadow'

    root.appendChild(bubble)
    root.appendChild(shadow)
    root.appendChild(img)

    var style = document.createElement('style')
    style.textContent = [
      '.dsh-cow-pet{position:fixed;top:0;left:0;z-index:2147483000;width:var(--size,132px);height:var(--size,132px);',
      'transform:translate3d(0,0,0);will-change:transform;touch-action:none;cursor:grab;opacity:0;',
      'transition:opacity .3s ease;filter:drop-shadow(0 10px 16px rgba(0,0,0,.34))}',
      '.dsh-cow-pet.ready{opacity:1}',
      '.dsh-cow-pet.broken{display:none}',
      '.dsh-cow-pet.grabbing{cursor:grabbing}',
      '.dsh-cow-pet-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;',
      'animation:cowBob 3.2s ease-in-out infinite;transform-origin:50% 92%;pointer-events:none;user-select:none}',
      '.dsh-cow-pet-shadow{position:absolute;left:18%;right:18%;bottom:2%;height:10%;border-radius:50%;',
      'background:radial-gradient(ellipse at center,rgba(0,0,0,.45),rgba(0,0,0,0) 70%);pointer-events:none}',
      '.dsh-cow-pet.bounce .dsh-cow-pet-img{animation:cowBounce .5s cubic-bezier(.2,.9,.3,1.2)}',
      '.dsh-cow-pet.sleeping .dsh-cow-pet-img{animation:cowSleep 4.6s ease-in-out infinite;filter:grayscale(.25) brightness(.9)}',
      '.dsh-cow-pet-bubble{position:absolute;bottom:calc(100% - 6px);left:50%;transform:translate(-50%,6px) scale(.92);',
      'width:max-content;max-width:calc(200px * var(--bubble-scale,1));min-width:calc(52px * var(--bubble-scale,1));',
      'padding:calc(6px * var(--bubble-scale,1)) calc(10px * var(--bubble-scale,1));border-radius:12px;background:rgba(22,24,30,.94);',
      'border:1px solid rgba(255,255,255,.14);color:#f2f5fa;',
      'font:calc(12px * var(--bubble-scale,1))/1.45 system-ui,"Microsoft YaHei",sans-serif;',
      'text-align:center;white-space:normal;word-break:break-word;opacity:0;pointer-events:none;',
      'transition:opacity .18s ease,transform .18s ease;box-shadow:0 6px 18px rgba(0,0,0,.35)}',
      '.dsh-cow-pet-bubble.show{opacity:1;transform:translate(-50%,0) scale(1)}',
      '.dsh-cow-pet-bubble.left{left:auto;right:50%;transform:translate(50%,6px) scale(.92)}',
      '.dsh-cow-pet-bubble.left.show{transform:translate(50%,0) scale(1)}',
      '@keyframes cowBob{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-4px) scale(1.014)}}',
      '@keyframes cowBounce{0%{transform:translateY(0) scale(1)}35%{transform:translateY(-12px) scale(1.06)}70%{transform:translateY(0) scale(.98)}100%{transform:translateY(0) scale(1)}}',
      '@keyframes cowSleep{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(2px) rotate(-5deg)}}',
      '@media (prefers-reduced-motion:reduce){.dsh-cow-pet-img,.dsh-cow-pet.bounce .dsh-cow-pet-img{animation:none}}',
      // ---- 开机那张「牛来！」：挂在牛头顶的气泡，不是全屏弹窗 ----
      '.dsh-cow-pet-card{position:absolute;left:50%;bottom:calc(100% + 12px);z-index:5;width:min(calc(184px * var(--bubble-scale,1)),48vw);',
      'transform:translateX(-50%) translateY(6px) scale(.94);transform-origin:50% 100%;opacity:0;',
      'background:#14171f;border:1px solid rgba(255,255,255,.14);border-radius:14px;',
      'box-shadow:0 18px 42px rgba(0,0,0,.5);transition:opacity .18s ease,transform .22s cubic-bezier(.2,.9,.3,1.2);',
      'font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif;cursor:default}',
      '.dsh-cow-pet-card.in{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}',
      '.dsh-cow-pet-card.flip{bottom:auto;top:calc(100% + 14px);transform-origin:50% 0}',
      '.dsh-cow-pet-card img{display:block;width:100%;height:auto;border-radius:13px 13px 0 0}',
      '.dsh-cow-pet-card-foot{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 8px}',
      '.dsh-cow-pet-card-tip{color:#e6ecf6;font-size:11.5px;line-height:1.3;font-weight:600}',
      '.dsh-cow-pet-card-btn{flex:0 0 auto;padding:3px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.16);',
      'background:#2f6bff;color:#fff;font:11px/1.4 system-ui;cursor:pointer}',
      '.dsh-cow-pet-card-btn:hover{background:#3f7bff}',
      '.dsh-cow-pet-shot{width:min(calc(190px * var(--bubble-scale,1)),46vw);padding:0;overflow:hidden}',
      '.dsh-cow-pet-settings{width:min(258px,72vw);padding:10px 12px 12px;cursor:default}',
      '.dsh-cow-pet-set-title{font:600 12px/1.4 system-ui,"Microsoft YaHei",sans-serif;color:#e8eef8;margin:0 0 8px}',
      '.dsh-cow-pet-row{display:grid;grid-template-columns:34px 1fr 42px;align-items:center;gap:8px;margin:7px 0}',
      '.dsh-cow-pet-lab{font:11px/1.3 system-ui,"Microsoft YaHei",sans-serif;color:#9aa5b8;white-space:nowrap}',
      '.dsh-cow-pet-val{font:11px/1.3 ui-monospace,Consolas,monospace;color:#cdd7e6;text-align:right}',
      '.dsh-cow-pet-row input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:2px;',
      'background:linear-gradient(90deg,#3b7bff,#6f9dff);outline:none;cursor:pointer}',
      '.dsh-cow-pet-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;',
      'background:#fff;border:1px solid rgba(0,0,0,.25);box-shadow:0 1px 3px rgba(0,0,0,.4);cursor:pointer}',
      '.dsh-cow-pet-set-foot{display:flex;justify-content:space-between;align-items:center;margin-top:10px}',
      '.dsh-cow-pet-set-hint{font:10.5px/1.3 system-ui,"Microsoft YaHei",sans-serif;color:#7b8698}',
      '.dsh-cow-pet-shot img{display:block;width:100%;height:auto;border-radius:13px}',
      '.dsh-cow-pet-card::after{content:"";position:absolute;left:var(--tail-x,50%);bottom:-6px;width:11px;height:11px;background:#14171f;',
      'border-right:1px solid rgba(255,255,255,.14);border-bottom:1px solid rgba(255,255,255,.14);',
      'transform:translateX(-50%) rotate(45deg)}',
      '.dsh-cow-pet-card.flip::after{bottom:auto;top:-6px;border-right:0;border-bottom:0;',
      'border-left:1px solid rgba(255,255,255,.14);border-top:1px solid rgba(255,255,255,.14);',
      'transform:translateX(-50%) rotate(45deg)}',
    ].join('')

    root.addEventListener('pointerdown', onDown)
    root.addEventListener('pointermove', onMove)
    root.addEventListener('pointerup', onUp)
    root.addEventListener('pointercancel', onUp)
    root.addEventListener('dblclick', onDblClick)
    root.addEventListener('contextmenu', function (ev) {
      ev.preventDefault()
      ev.stopPropagation()
      toggleSettings()
    })

    document.body.appendChild(style)
    document.body.appendChild(root)

    applyScale()
    applyPosition()
    applySleeping()
    watchActivity()
    pollPhase()
    window.addEventListener('resize', applyPosition)
  }

  // ---------- 开机那张「牛来！」：挂在牛头顶的气泡，每次启动弹一次 ----------
  var cardOpen = false
  var shownThisSession = false

  // 气泡跟着牛走：横向贴边就往里推，头顶放不下就翻到脚下
  // 用 offsetWidth 量，不受入场动画的 scale 影响
  function placeCard(card) {
    card.classList.remove('flip')
    card.style.marginLeft = '0px'
    var w = card.offsetWidth
    var h = card.offsetHeight
    var petR = root.getBoundingClientRect()
    var cx = petR.left + petR.width / 2
    var pad = 10
    var left = cx - w / 2
    var shift = 0
    if (left < pad) shift = pad - left
    else if (left + w > window.innerWidth - pad) shift = window.innerWidth - pad - (left + w)
    card.style.marginLeft = Math.round(shift) + 'px'
    if (petR.top < h + 18) card.classList.add('flip')
    // 气泡比牛宽得多，尾巴要指着牛，不是指着气泡中心
    var rect = card.getBoundingClientRect()
    var tx = clamp(cx - rect.left, 14, rect.width - 14)
    card.style.setProperty('--tail-x', Math.round(tx) + 'px')
    return { cx: cx, w: w }
  }

  function showStartup() {
    if (shownThisSession || state.enabled === false || !root) return
    shownThisSession = true

    var card = document.createElement('div')
    card.className = 'dsh-cow-pet-card'

    var im = document.createElement('img')
    im.src = BASE + '/startup.webp'
    im.alt = '牛来！'
    im.draggable = false

    var foot = document.createElement('div')
    foot.className = 'dsh-cow-pet-card-foot'

    var tip = document.createElement('span')
    tip.className = 'dsh-cow-pet-card-tip'
    tip.textContent = '牛来！'

    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'dsh-cow-pet-card-btn'
    btn.textContent = '出发'

    foot.appendChild(tip)
    foot.appendChild(btn)
    card.appendChild(im)
    card.appendChild(foot)

    var closed = false
    function cleanup() {
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      cardOpen = false
      scheduleIdle()
    }

    // 启动那几秒别被"点一下别处"顺手关掉：6 秒后自己收
    var autoHide = setTimeout(function () { close() }, 6000)


    function close() {
      if (closed) return
      closed = true
      clearTimeout(autoHide)
      card.classList.remove('in')
      setTimeout(function () {
        card.remove()
      }, 220)
      cleanup()
    }

    function onOutside(ev) {
      // DSH 启动时会有一堆点击，前 1.5 秒当作误触
      if (Date.now() - openedAt < 1500) return
      if (!card.contains(ev.target)) close()
    }
    function onKey(ev) {
      if (ev.key === 'Escape') close()
    }
    function onResize() {
      placeCard(card)
    }

    // 图取不到（host 还没重启、路由没注册）就当没这回事，别留个空框
    im.addEventListener('error', function () {
      closed = true
      clearTimeout(autoHide)
      card.remove()
      cleanup()
    })

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation()
      close()
    })

    // 跟着牛走：在 root 里，拖动/换位置时自动一起动
    var openedAt = Date.now()
    root.appendChild(card)
    cardOpen = true
    clearTimeout(idleTimer)
    requestAnimationFrame(function () {
      placeCard(card)
      card.classList.add('in')
      // 图加载完高度会变，落定后再对一次
      setTimeout(function () {
        if (!closed) placeCard(card)
      }, 260)
    })

    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
  }
  // ---------- 三种时机：思考中 / 等权限 / 干完 ----------
  var MOOD = BASE + '/mood/'
  var MOOD_IMAGES = {
    thinking: ['1.jpg', 'niusi.jpg'],
    waiting: ['2.jpg', '4.jpg'],
    done: ['5.jpg', '7.webp'],
  }
  function thinkEvery() {
    var secs = clamp(Number(state.thinkInterval) || BASE_THINK, 2, 60)
    return secs * 1000
  }
  var shotEl = null
  var shotTimer = null
  var phaseName = 'idle'
  var phaseSince = 0
  var lastThinkAt = 0

  function hideShot(instant) {
    clearTimeout(shotTimer)
    var el = shotEl
    shotEl = null
    if (!el) return
    el.classList.remove('in')
    if (instant) el.remove()
    else setTimeout(function () { el.remove() }, 200)
  }

  function showShot(name, ms) {
    if (!root || state.enabled === false || cardOpen || settingsEl) return
    hideShot(true)
    var card = document.createElement('div')
    card.className = 'dsh-cow-pet-card dsh-cow-pet-shot'
    var im = document.createElement('img')
    im.alt = ''
    im.draggable = false
    im.src = MOOD + name
    im.addEventListener('error', function () {
      if (shotEl === card) hideShot(true)
    })
    card.appendChild(im)
    // 图片气泡一开，文字气泡就让位，免得压在图片底下
    if (bubble) bubble.classList.remove('show')
    root.appendChild(card)
    shotEl = card
    requestAnimationFrame(function () {
      placeCard(card)
      card.classList.add('in')
      setTimeout(function () {
        if (shotEl === card) placeCard(card)
      }, 200)
    })
    if (ms) {
      clearTimeout(shotTimer)
      shotTimer = setTimeout(function () {
        if (shotEl === card) hideShot()
      }, ms)
    }
  }

  function onPhase(next, changed) {
    if (state.sleeping) {
      hideShot(true)
      return
    }
    if (next === 'thinking') {
      if (changed) lastThinkAt = 0
      var now = Date.now()
      if (now - lastThinkAt >= thinkEvery()) {
        lastThinkAt = now
        showShot(pick(MOOD_IMAGES.thinking), 5200)
      }
    } else if (next === 'waiting') {
      // 等权限：图一直挂着，阶段变了才收
      if (changed) showShot(pick(MOOD_IMAGES.waiting), 0)
    } else if (next === 'done') {
      if (changed) {
        hideShot(true)
        showShot(pick(MOOD_IMAGES.done), 4200)
      }
    } else if (changed) {
      hideShot()
    }
  }

  function pollPhase() {
    fetch(BASE + '/phase.json', { headers: { Accept: 'application/json' } })
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        var list = (data && data.events) || []
        var asked = -1
        var decided = -1
        for (var i = 0; i < list.length; i++) {
          var ty = String(list[i] || '')
          if (/approval\/asked/i.test(ty)) asked = i
          else if (/approval\/(decided|resolved|rejected|granted)/i.test(ty)) decided = i
        }
        // 配对优先：asked 比 decided 新 = 正等你点头
        var phaseRaw = (data && data.phase) || 'idle'
        var next = asked > decided ? 'waiting' : phaseRaw === 'waiting' ? 'thinking' : phaseRaw
        var since = Number(data && data.since) || 0
        var changed = next !== phaseName || since !== phaseSince
        phaseName = next
        phaseSince = since
        onPhase(next, changed)
      })
      .catch(function () {})
      .then(function () {
        setTimeout(pollPhase, 1500)
      })
  }

  // ---------- 右键设置：大小 / 气泡大小 / 思考间隔 ----------
  var settingsEl = null
  var saveTimer = null
  var pendingPatch = null

  function saveSoon(patch) {
    pendingPatch = Object.assign(pendingPatch || {}, patch)
    clearTimeout(saveTimer)
    saveTimer = setTimeout(function () {
      var out = pendingPatch || {}
      pendingPatch = null
      save(out)
    }, 420)
  }

  function onSettingsOutside(ev) {
    if (settingsEl && !settingsEl.contains(ev.target)) closeSettings()
  }

  function closeSettings() {
    if (!settingsEl) return
    var el = settingsEl
    settingsEl = null
    document.removeEventListener('pointerdown', onSettingsOutside, true)
    el.classList.remove('in')
    setTimeout(function () {
      el.remove()
    }, 200)
  }

  function toggleSettings() {
    if (settingsEl) {
      closeSettings()
      return
    }
    openSettings()
  }

  function settingsRow(panel, label, min, max, value, fmt, onChange) {
    var wrap = document.createElement('div')
    wrap.className = 'dsh-cow-pet-row'

    var lab = document.createElement('span')
    lab.className = 'dsh-cow-pet-lab'
    lab.textContent = label

    var input = document.createElement('input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = '1'
    input.value = String(value)

    var val = document.createElement('span')
    val.className = 'dsh-cow-pet-val'
    val.textContent = fmt(value)

    input.addEventListener('input', function () {
      var v = Number(input.value)
      val.textContent = fmt(v)
      onChange(v)
      // 面板自身宽度也会跟着气泡比例变，重新贴一次位
      if (settingsEl) placeCard(settingsEl)
    })

    wrap.appendChild(lab)
    wrap.appendChild(input)
    wrap.appendChild(val)
    panel.appendChild(wrap)
    return input
  }

  function openSettings() {
    if (!root) return
    closeSettings()
    hideShot(true)
    if (bubble) bubble.classList.remove('show')

    var panel = document.createElement('div')
    panel.className = 'dsh-cow-pet-card dsh-cow-pet-settings'
    panel.addEventListener('pointerdown', function (ev) {
      ev.stopPropagation()
    })
    panel.addEventListener('contextmenu', function (ev) {
      ev.preventDefault()
      ev.stopPropagation()
    })

    var title = document.createElement('div')
    title.className = 'dsh-cow-pet-set-title'
    title.textContent = '桌宠设置'
    panel.appendChild(title)

    settingsRow(panel, '大小', 50, 200, Math.round(state.scale || 100), function (v) {
      return v + '%'
    }, function (v) {
      state.scale = v
      applyScale(true)
      applyPosition()
      saveSoon({ scale: v, size: petSize() })
    })

    settingsRow(panel, '气泡', 60, 220, Math.round(state.bubbleScale || 100), function (v) {
      return v + '%'
    }, function (v) {
      state.bubbleScale = v
      applyScale()
      saveSoon({ bubbleScale: v })
    })

    var maxPct = Math.round((60 / BASE_THINK) * 100)
    var minPct = Math.round((2 / BASE_THINK) * 100)
    var curPct = clamp(Math.round(((Number(state.thinkInterval) || BASE_THINK) / BASE_THINK) * 100), minPct, 400)
    settingsRow(panel, '频率', minPct, 400, curPct, function (v) {
      return clamp(Math.round((BASE_THINK * v) / 100), 2, 60) + 's'
    }, function (v) {
      var secs = clamp(Math.round((BASE_THINK * v) / 100), 2, 60)
      state.thinkInterval = secs
      lastThinkAt = 0
      saveSoon({ thinkInterval: secs })
    })

    var foot = document.createElement('div')
    foot.className = 'dsh-cow-pet-set-foot'
    var hint = document.createElement('span')
    hint.className = 'dsh-cow-pet-set-hint'
    hint.textContent = '右键开关 · 双击睡觉'
    var reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'dsh-cow-pet-card-btn'
    reset.textContent = '恢复默认'
    reset.addEventListener('click', function (ev) {
      ev.stopPropagation()
      state.scale = 100
      state.bubbleScale = 100
      state.thinkInterval = BASE_THINK
      applyScale(true)
      applyPosition()
      saveSoon({ scale: 100, size: petSize(), bubbleScale: 100, thinkInterval: BASE_THINK })
      closeSettings()
    })
    foot.appendChild(hint)
    foot.appendChild(reset)
    panel.appendChild(foot)

    root.appendChild(panel)
    settingsEl = panel
    clearTimeout(idleTimer)
    requestAnimationFrame(function () {
      placeCard(panel)
      panel.classList.add('in')
      setTimeout(function () {
        if (settingsEl === panel) placeCard(panel)
      }, 200)
    })
    document.addEventListener('pointerdown', onSettingsOutside, true)
  }

  function boot() {
    fetch(STATE_URL, { headers: { Accept: 'application/json' } })
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        var saved = (data && data.state) || {}
        state = Object.assign({}, DEFAULTS, saved)
        var sprites = (data && data.sprites) || []
        if (state.enabled === false) return
        build(sprites.length ? sprites : ['walk'])
        showStartup()
      })
      .catch(function () {
        // host 没起来（比如刷新太早），稍后再试一次
        setTimeout(boot, 1500)
      })
  }

  if (document.body) boot()
  else document.addEventListener('DOMContentLoaded', boot, { once: true })
})()
