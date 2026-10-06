export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': {
      /** 速率限制窗口（five_hour / seven_day） */
      limits: Limit[]
      /** 本会话花费（美元），取不到为 null */
      cost: number | null
      /** 累计上行：新输入 + 缓存写入 */
      up: number
      /** 累计下行：输出 */
      down: number
      /** 累计缓存读取量 */
      cache: number
      /** 当前上下文占用（tokens），缓存格 'context' 口径用 */
      context: number | null
      /** 最近一次刷新时间，仅用来触发重绘 */
      now: number
      /** token 累计是否不完整（加载前已有用量且无法恢复） */
      isPartial: boolean
      /** 最近一次主对话模型请求完成的时间（毫秒），缓存倒计时的起点；还没有请求为 null */
      cacheAt: number | null
      /** 最近一次主对话请求的缓存命中率 0~1：cache_read / (cache_read + input + cache_creation) */
      cacheHit: number | null
    }
  }
}
