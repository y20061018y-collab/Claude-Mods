import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Limit } from '../types'

// ───────────── 配置区：颜色、阈值、刷新间隔都在这里改 ─────────────
const CONFIG = {
  refreshMs: 60_000, // 倒计时刷新间隔（毫秒）；窗口重置那一刻会额外立即刷新
  warnAt: 60, // 用量 ≥ 此值：黄色
  dangerAt: 85, // 用量 ≥ 此值：红色
  windowMs: {
    five_hour: 5 * 3600_000,
    seven_day: 7 * 24 * 3600_000,
  } as Record<string, number>,
  color: {
    ok: '#4fa36b', // 进度条：<warnAt
    warn: '#d9a21b', // 进度条：warnAt ~ dangerAt
    danger: '#d4503f', // 进度条：>dangerAt
    h5: '#3f9d7a', // 5h 胶囊（绿色系）
    d7: '#7c5cd6', // 7d 胶囊（紫色系）
    up: '#d9604c', // 上行（红/橙）
    down: '#4fa36b', // 下行（绿）
    cache: '#4f6fd8', // 缓存（蓝）
    cost: '#b8892e', // 花费（米黄）
  },
  pillAlpha: 0.16, // 胶囊背景浅色的不透明度
  font: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace",
  fontSize: 15, // 字号（像素）；条高、图标都按它缩放
  charRatio: 0.6, // 字符宽 = fontSize × 此值；文字用 textLength 锁成这个宽度，换字体也不会错位
  padX: 16, // 胶囊左右内边距
  barWidth: 92, // 进度条长度（像素）
  // 自动隐藏：SVG 固定 viewBox、缩放到容器；只有「缩放后字号 < minFontPx」才按 缓存→下行→上行→花费 隐藏。
  // 缩放后字号 = fontSize × 容器像素宽 ÷ viewBox 宽；容器像素宽 = 列数 × cellPx。cellPx 没有实测前保持关闭。
  autoHide: false,
  minFontPx: 11,
  cellPx: 8,
  // 'auto' 跟随系统深浅色；引擎没有把应用主题暴露给 Mod，若与应用主题不一致可手动设 'light' / 'dark'
  theme: 'auto' as 'auto' | 'light' | 'dark',
  keepSessions: 20, // $.store 里最多保留最近多少个会话的 token 存档
  // 缓存格口径：
  //   'cumulative'：累计缓存读取（cache_read_input_tokens 每轮累加）。每轮都会把整段上下文再读一遍，
  //                 所以增长很快，长会话轻松到几十 M；
  //   'context'：当前上下文占用，不超过模型窗口（十万到百万级），会随压缩/清空回落。
  // 两者差一到两个数量级；样图里的 954.2k 更接近 'context'。
  cacheMode: 'cumulative' as 'cumulative' | 'context',
}
// ──────────────────────────────────────────────────────────────

const F = CONFIG.fontSize
const CW = F * CONFIG.charRatio // 单个字符宽度
const H = Math.round(F * 2.5) // 条的高度
const ICON_PX = Math.round(F * 1.2) // 图标边长（路径按 16×16 画，再缩放）
const GAP = 10 // 胶囊间距

// 值都放进 $.state：热重载后保留
const limitsA = atom({ plugin: 'usage-bar', key: 'limits' } as const, [] as Limit[])
const costA = atom({ plugin: 'usage-bar', key: 'cost' } as const, null as number | null)
const upA = atom({ plugin: 'usage-bar', key: 'up' } as const, 0)
const downA = atom({ plugin: 'usage-bar', key: 'down' } as const, 0)
const cacheA = atom({ plugin: 'usage-bar', key: 'cache' } as const, 0)
const ctxA = atom({ plugin: 'usage-bar', key: 'context' } as const, null as number | null)
const nowA = atom({ plugin: 'usage-bar', key: 'now' } as const, 0)
const partialA = atom({ plugin: 'usage-bar', key: 'isPartial' } as const, false)

// ───────────── 格式化 ─────────────
// 数字：<1000 原样，≥1000 用 k，≥1,000,000 用 M，保留一位小数
const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

// 剩余时间：1d 7h / 2h 40m / 40m
const fmtTime = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m % 60}m` : `${m % 60}m`
}

const levelColor = (pct: number) =>
  pct >= CONFIG.dangerAt ? CONFIG.color.danger : pct >= CONFIG.warnAt ? CONFIG.color.warn : CONFIG.color.ok

// ───────────── 窗口计算 ─────────────
type View = { pct: number; remaining: number; elapsed: number; reset: number }

// 窗口已过 resetsAt 就立即归零，并滚动到下一个窗口（不等下一次 API 响应）
function windowView(l: Limit | undefined, now: number): View | null {
  const win = l && CONFIG.windowMs[l.kind]
  if (!l || !l.resetsAt || !win) return null
  let reset = Date.parse(l.resetsAt)
  let pct = l.percentUsed
  if (now >= reset) {
    reset += Math.ceil((now - reset + 1) / win) * win
    pct = 0
  }
  const remaining = reset - now
  return { pct, remaining, reset, elapsed: Math.min(1, Math.max(0, 1 - remaining / win)) }
}

// ───────────── SVG 绘制 ─────────────
// 图标：16×16 描边路径
const ICON = {
  gauge: '<path d="M2.5 12.5a6.5 6.5 0 1 1 11 0"/><path d="M8 9.5l2.6-3.2"/>',
  calendar: '<rect x="2" y="3" width="12" height="11" rx="2.2"/><path d="M2 7h12M5.3 1.5v3M10.7 1.5v3"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.3 1.4"/>',
  up: '<path d="M8 10V2.5M5 5.3l3-3 3 3M2.5 10v3.5h11V10"/>',
  down: '<path d="M8 2v7.5M5 6.5l3 3 3-3M2.5 10v3.5h11V10"/>',
  layers: '<path d="M8 1.8l6 3.2-6 3.2-6-3.2z"/><path d="M2 8l6 3.2L14 8M2 11l6 3.2 6-3.2"/>',
  dollar:
    '<circle cx="8" cy="8" r="6.2"/><path d="M8 4v8M10.2 6.3C9.8 5.6 9 5.3 8 5.3c-1.2 0-2 .6-2 1.5S6.8 8 8 8s2 .6 2 1.5-.8 1.5-2 1.5c-1 0-1.8-.4-2.2-1.1"/>',
}
const SLOT = ICON_PX + 7 // 图标 + 与文字的间距

const icon = (name: keyof typeof ICON, x: number, color: string) =>
  `<g transform="translate(${x} ${(H - ICON_PX) / 2}) scale(${ICON_PX / 16})" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</g>`

// 文字用 textLength 锁定宽度：布局只依赖字符数，不依赖实际字体
const text = (s: string, x: number, cls: string, extra = '') =>
  `<text x="${x}" y="${H / 2 + F * 0.35}" class="${cls}" textLength="${s.length * CW}" lengthAdjust="spacingAndGlyphs" ${extra}>${s}</text>`

const tw = (s: string, min = 0) => Math.max(s.length, min) * CW

// 一个胶囊：背景 + 内容；body 按起点 x 绘制，返回 { svg, width }（width 与 x 无关）
function pill(x: number, color: string, body: (x0: number) => { svg: string; width: number }) {
  const inner = body(x + CONFIG.padX)
  const w = inner.width + CONFIG.padX * 2
  const bg = `<rect x="${x}" y="1" width="${w}" height="${H - 2}" rx="${(H - 2) / 2}" fill="${color}" fill-opacity="${CONFIG.pillAlpha}"/>`
  return { svg: bg + inner.svg, width: w }
}

// 窗口胶囊：图标 + 标签 + 进度条(填充=已用额度，竖线=时间进度) + 百分比 | 时钟 + 剩余时间
function windowPill(x: number, ic: 'gauge' | 'calendar', label: string, color: string, v: View | null, bw: number) {
  return pill(x, color, x0 => {
    let c = x0
    let s = icon(ic, c, color)
    c += SLOT
    s += text(label, c, 'd')
    c += tw(label) + 8

    // 进度条
    s += `<rect x="${c}" y="${H / 2 - 4.5}" width="${bw}" height="9" rx="4.5" class="trk"/>`
    if (v) {
      const fw = v.pct > 0 ? Math.max(7, (bw * Math.min(100, v.pct)) / 100) : 0
      if (fw) s += `<rect x="${c}" y="${H / 2 - 4.5}" width="${fw}" height="9" rx="4.5" fill="${levelColor(v.pct)}"/>`
      // 竖线：时间进度；填充越过竖线 = 用得比时间快，竖线转红提醒
      const mx = c + bw * v.elapsed
      const style = fw > bw * v.elapsed ? `style="stroke:${CONFIG.color.danger}"` : ''
      s += `<line x1="${mx}" x2="${mx}" y1="${H / 2 - 8}" y2="${H / 2 + 8}" stroke-width="2" stroke-linecap="round" class="mk" ${style}/>`
    }
    c += bw + 8

    const pct = v ? `${Math.round(v.pct)}%` : '--'
    s += text(pct, c, 't', 'font-weight="700"')
    c += tw(pct, 4) + 8

    s += `<line x1="${c}" x2="${c}" y1="${H / 2 - 9}" y2="${H / 2 + 9}" class="dv"/>`
    c += 9
    s += icon('clock', c, color)
    c += SLOT
    const t = v ? fmtTime(v.remaining) : '--'
    s += text(t, c, 'd')
    c += tw(t, 6)
    return { svg: s, width: c - x0 }
  })
}

// 数值胶囊：图标 + 数字；weak=true（token 累计不完整）时用虚线描边 + 数字弱化
function valuePill(x: number, ic: keyof typeof ICON, color: string, value: string, weak = false) {
  const r = pill(x, color, x0 => ({
    svg: icon(ic, x0, color) + text(value, x0 + SLOT, weak ? 'd' : 't'),
    width: SLOT + tw(value, 4),
  }))
  if (!weak) return r
  const ring = `<rect x="${x + 0.5}" y="1.5" width="${r.width - 1}" height="${H - 3}" rx="${(H - 3) / 2}" fill="none" stroke="${color}" stroke-opacity=".75" stroke-width="1.5" stroke-dasharray="4 3"/>`
  return { svg: r.svg + ring, width: r.width }
}

type Data = { h5: View | null; d7: View | null; up: number; down: number; cache: number; cost: number | null }
type Part = { id: string; draw: (x: number, bw: number) => { svg: string; width: number } }

// 固定 viewBox：所有坐标都在 viewBox 内部算，容器把它整体缩放；不依赖容器像素宽度。
// slotPx：容器像素宽（仅 autoHide 用）；缩放后字号低于 minFontPx 时才按 缓存→下行→上行→花费 整颗隐藏，
// 5h / 7d 始终保留，绝不画出被裁掉半截的胶囊。
function buildSvg(d: Data, partial: boolean, slotPx: number) {
  const all: Part[] = [
    { id: 'h5', draw: (x, bw) => windowPill(x, 'gauge', '5h', CONFIG.color.h5, d.h5, bw) },
    { id: 'd7', draw: (x, bw) => windowPill(x, 'calendar', '7d', CONFIG.color.d7, d.d7, bw) },
    { id: 'up', draw: x => valuePill(x, 'up', CONFIG.color.up, fmtTokens(d.up), partial) },
    { id: 'down', draw: x => valuePill(x, 'down', CONFIG.color.down, fmtTokens(d.down), partial) },
    { id: 'cache', draw: x => valuePill(x, 'layers', CONFIG.color.cache, fmtTokens(d.cache), partial) },
    { id: 'cost', draw: x => valuePill(x, 'dollar', CONFIG.color.cost, d.cost === null ? '--' : `$${d.cost.toFixed(2)}`) },
  ]
  const hideOrder = ['cache', 'down', 'up', 'cost']
  const bw = CONFIG.barWidth
  const widthOf = (parts: Part[]) => parts.reduce((n, p) => n + p.draw(0, bw).width, 0) + GAP * (parts.length - 1) + 2

  let parts = all
  while (CONFIG.autoHide && hideOrder.length && (F * slotPx) / widthOf(parts) < CONFIG.minFontPx) {
    const gone = hideOrder.shift()
    parts = parts.filter(p => p.id !== gone)
  }

  let x = 1
  let body = ''
  let tokenEnd = 0 // 上行/下行/缓存三格的右端，「自加载起」角标挂在这里
  for (const p of parts) {
    const r = p.draw(x, bw)
    body += r.svg
    if (p.id === 'up' || p.id === 'down' || p.id === 'cache') tokenEnd = x + r.width
    x += r.width + GAP
  }
  const w = Math.ceil(x - GAP + 1) // 去掉末尾多余的间距

  // 「自加载起」角标：压在三格右上沿，实心琥珀底 + 白字，比正文更醒目
  let top = 0
  if (partial && tokenEnd) {
    const fs = Math.round(F * 0.72)
    const tagW = 4 * fs + 12
    const tagH = fs + 7
    top = Math.round(tagH / 2) + 1
    body += `<g transform="translate(${tokenEnd - tagW - 6} ${-top + 1})"><rect width="${tagW}" height="${tagH}" rx="${tagH / 2}" fill="${CONFIG.color.cost}"/><text x="${tagW / 2}" y="${tagH / 2 + fs * 0.36}" text-anchor="middle" font-size="${fs}" font-weight="700" fill="#fff" font-family="system-ui, 'Microsoft YaHei', sans-serif">自加载起</text></g>`
  }
  const totalH = H + top

  // 深浅色：auto 用 prefers-color-scheme；胶囊底色半透明，两种底色上都能读
  const light = '.t{fill:#2b2b2b}.d{fill:#707070}.trk{fill:#888;fill-opacity:.3}.mk{stroke:#222}.dv{stroke:#888;stroke-opacity:.5}'
  const dark = '.t{fill:#ececec}.d{fill:#a6a6a6}.mk{stroke:#f2f2f2}'
  const css =
    CONFIG.theme === 'dark'
      ? light + dark
      : CONFIG.theme === 'light'
        ? light
        : `${light}@media (prefers-color-scheme:dark){${dark}}`
  return {
    w,
    vbH: totalH,
    shown: parts.map(p => p.id).join(','),
    // width/height 只是 viewBox 的原始尺寸；容器把整张图等比缩放
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${totalH}" viewBox="0 ${-top} ${w} ${totalH}" font-family="${CONFIG.font}" font-size="${F}"><style>${css}</style>${body}</svg>`,
  }
}

// 以下辅助函数必须是顶层函数声明：引擎只允许把 $ 传给这样的函数
let resetTimer: { cancel: () => void } | null = null
// 刷新时间戳：只为触发重绘（倒计时、归零）
async function touch($: any) {
  const t = await $.clock.now()
  await update($, nowA, () => t)
}

// 在最近一次窗口重置的时刻安排一次立即刷新，到点就归零
async function scheduleReset($: any, limits: Limit[]) {
  resetTimer?.cancel()
  resetTimer = null
  const now = await $.clock.now()
  const resets = limits.map(l => windowView(l, now)?.reset).filter((r): r is number => r !== undefined)
  if (!resets.length) return
  const wait = Math.min(...resets) - now + 300
  resetTimer = $.clock.after(wait, async () => {
    await touch($)
    await scheduleReset($, limits)
  })
}

// 把一次用量快照写进 state
async function sync($: any, limits: Limit[], cost: number | null, ctx: number | null) {
  await update($, limitsA, () => limits)
  await update($, costA, () => cost)
  await update($, ctxA, () => ctx)
  await touch($)
  await scheduleReset($, limits)
}

type Saved = { up: number; down: number; cache: number }

// $.store 按会话 id 分别存档：key = tokens:<会话id>，value = 该会话的累计值；
// tokens-index 记录会话 id 的先后顺序，只保留最近 CONFIG.keepSessions 个，超出就删最旧的
async function loadTokens($: any, id: string): Promise<Saved | undefined> {
  const saved = (await $.store.get(`tokens:${id}`)) as Saved | undefined
  if (saved) return saved
  // 兼容旧版单份存档（key = tokens，里面带 id）
  const legacy = (await $.store.get('tokens')) as (Saved & { id: string }) | undefined
  return legacy && legacy.id === id ? legacy : undefined
}

async function saveTokens($: any, id: string, v: Saved) {
  await $.store.set(`tokens:${id}`, v)
  const old = ((await $.store.get('tokens-index')) as string[] | undefined) ?? []
  const index = [...old.filter(x => x !== id), id] // 当前会话移到最新
  while (index.length > CONFIG.keepSessions) {
    const oldest = index.shift()
    await $.store.delete(`tokens:${oldest}`)
  }
  await $.store.set('tokens-index', index)
  await $.store.delete('tokens') // 旧版单份存档不再需要
}

// 去重：同一请求（agentId + turnId + index）只计一次；只保留最近 SEEN_MAX 个键
const SEEN_MAX = 200
const SAVE_EVERY_MS = 2000
const seen = new Set<string>()
let lastSaveAt = 0
let dirty = false

async function persist($: any) {
  await saveTokens($, await $.session.id(), {
    up: await read($, upA),
    down: await read($, downA),
    cache: await read($, cacheA),
  })
  lastSaveAt = await $.clock.now()
  dirty = false
}

// 节流保存：最多每 SAVE_EVERY_MS 一次；没存的标记 dirty，由 flushTokens 补存
async function saveThrottled($: any) {
  dirty = true
  if ((await $.clock.now()) - lastSaveAt >= SAVE_EVERY_MS) await persist($)
}

async function flushTokens($: any) {
  if (dirty) await persist($)
}

async function countStep($: any, e: { turnId: string; index: number; agentId?: string }, r: { usage: any }) {
  const u = r?.usage
  if (!u) return
  const key = `${e.agentId ?? ''}|${e.turnId}|${e.index}`
  if (seen.has(key)) return
  seen.add(key)
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string)
  await update($, upA, n => n + u.input_tokens + u.cache_creation_input_tokens)
  await update($, downA, n => n + u.output_tokens)
  await update($, cacheA, n => n + u.cache_read_input_tokens)
  await saveThrottled($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    const u = await $.session.usage()
    const held = await $.state.get({ plugin: 'usage-bar', key: 'up' } as const)

    // 热重载：state 还在（version>0），不动；全新加载：尝试从 $.store 恢复累计值
    if (held.version === 0) {
      const saved = await loadTokens($, id)
      const isRestored = !!saved
      if (isRestored) {
        await update($, upA, () => saved.up)
        await update($, downA, () => saved.down)
        await update($, cacheA, () => saved.cache)
        await update($, partialA, () => false) // 恢复成功：虚线边框和「自加载起」角标自动消失
      } else {
        // 无法恢复：若加载前已有花费，说明 token 累计不完整，条上标「自加载起」
        await update($, partialA, () => (u.cost?.usd ?? 0) > 0)
      }
    }

    await sync($, u.rateLimits, u.cost?.usd ?? null, u.context.tokens ?? null)
    $.clock.every(CONFIG.refreshMs, () => touch($))
    return next(e)
  })

  // 用量/限额变化（每轮结束、窗口走过一整点）时推送
  on('session.measure', async ($, e, next) => {
    await sync($, e.rateLimits, e.cost?.usd ?? null, e.context.tokens ?? null)
    return next(e)
  })

  // 每次模型请求完成就累计 token（比 turn.complete 细，一轮里数字就会涨）；
  // turn.complete.usage 是本轮各 step 之和，所以这里不能再在 turn.complete 里累加
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    await countStep($, e, r)
    return r
  })

  // 一轮结束 / 会话结束：补存一次，避免节流漏掉最后几步
  on('turn.complete', async ($, e, next) => {
    await flushTokens($)
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    await flushTokens($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    await read($, nowA) // 订阅：定时刷新会触发重绘

    const now = await $.clock.now()
    const limits = await read($, limitsA)
    const data: Data = {
      h5: windowView(limits.find(l => l.kind === 'five_hour'), now),
      d7: windowView(limits.find(l => l.kind === 'seven_day'), now),
      up: await read($, upA),
      down: await read($, downA),
      cache: CONFIG.cacheMode === 'context' ? ((await read($, ctxA)) ?? 0) : await read($, cacheA),
      cost: await read($, costA),
    }
    const partial = await read($, partialA)
    const { Box, Text, Svg } = $.ui.resolve(e) as any

    // 终端没有 Svg：退回纯文字
    if (e.surface === 'terminal') {
      const f = (v: View | null) => (v ? `${Math.round(v.pct)}% ↻${fmtTime(v.remaining)}` : '--')
      return (
        <Text dimColor>
          {`5h ${f(data.h5)} │ 7d ${f(data.d7)} │ ↑${fmtTokens(data.up)} ↓${fmtTokens(data.down)} cache ${fmtTokens(data.cache)} │ ${
            data.cost === null ? '--' : '$' + data.cost.toFixed(2)
          }${partial ? ' (自加载起)' : ''}`}
        </Text>
      )
    }

    const cols = e.props.bodyColumns
    const { source, w, vbH, shown } = buildSvg(data, partial, cols * CONFIG.cellPx)
    // 不传 width/height：容器按 viewBox 等比缩放到可用宽度
    return (
      <Box>
        <Svg source={source} alt="用量状态条" />
      </Box>
    )
  })
}
