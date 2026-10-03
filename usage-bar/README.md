# usage-bar

Claude Code 的 Mod：在输入框上方常驻一条用量状态条（桌面版 Code 标签页画成圆角胶囊，终端版退回纯文字）。

从左到右 6 个组件：

| 组件 | 内容 |
|---|---|
| 5h 窗口 | 已用百分比进度条 + 距重置的剩余时间 |
| 7d 窗口 | 同上 |
| 上行 | 本会话累计输入 token（新输入 + 缓存写入） |
| 下行 | 本会话累计输出 token |
| 缓存 | 累计缓存读取量，或当前上下文占用（见 `cacheMode`） |
| 花费 | 本会话累计花费（美元） |

进度条里：**填充 = 已用额度，竖线 = 窗口已过去的时间**。填充越过竖线说明用得比时间快，竖线会变红提醒。
颜色按用量分级：低于 `warnAt` 绿，`warnAt` 到 `dangerAt` 黄，高于 `dangerAt` 红。

## 数据来源：只读、不联网

只读取 Claude Code 自己提供的会话数据，不联网，不读取与展示无关的文件，也不写文件：

- 5h / 7d 用量与重置时间、本会话花费、上下文占用：`$.session.usage()` 与 `session.measure` 事件
- token 累计：每轮结束时 `turn.complete` 事件里的 `usage`
- 累计值存档：只写 Claude Code 为插件提供的 `$.store`（见下文「累计值与存档」）

取不到的项目显示 `--`。5h / 7d 额度只有订阅账号（如 Pro / Max）在收到第一次 API 响应后才有读数。

## 累计值与存档

token 累计从 Mod 加载那一刻开始算，每轮结束后按会话 id 存一份，resume 同一个会话时自动恢复。
只保留最近 `keepSessions`（默认 20）个会话的存档，超出就删最旧的。

- 全新会话：累计从 0 开始，就是完整的会话总量，不显示任何提示。
- 中途才加载 Mod、或 resume 了一个没有存档的会话：此时已有花费但 token 累计不完整，
  上行 / 下行 / 缓存三格改成虚线描边，右上角出现「自加载起」角标。

## 配置

所有选项在 `hooks/register.tsx` 顶部的 `CONFIG`，改完保存即热重载（开发期），或重新加载插件。

| 选项 | 说明 |
|---|---|
| `refreshMs` | 倒计时刷新间隔，毫秒，默认 60000。窗口重置那一刻会额外立即刷新并归零 |
| `warnAt` / `dangerAt` | 黄色 / 红色阈值（百分比），默认 60 / 85 |
| `windowMs` | 5h / 7d 窗口长度，用来算时间进度竖线，一般不用改 |
| `color` | 各胶囊与进度条的颜色 |
| `pillAlpha` | 胶囊背景浅色的不透明度，默认 0.16 |
| `font` / `fontSize` / `charRatio` | 字体、字号（像素）、字符宽度比例；文字宽度由字符数锁定，换字体不会错位 |
| `padX` / `barWidth` | 胶囊左右内边距、进度条长度（像素） |
| `autoHide` / `minFontPx` / `cellPx` | 窄窗口自动隐藏（默认关闭）。开启后，缩放后字号低于 `minFontPx` 时按 缓存 → 下行 → 上行 → 花费 依次隐藏，5h 和 7d 始终保留；`cellPx` 是终端一格约多少像素，用来估容器宽度，需按你的窗口实测 |
| `theme` | `'auto'` 跟随系统深浅色；应用主题与系统不一致时可手动设 `'light'` 或 `'dark'` |
| `keepSessions` | `$.store` 里保留的会话存档数量，默认 20 |
| `cacheMode` | 缓存格口径，见下 |

### `cacheMode`：缓存格的两种口径

- `'cumulative'`（默认）：**累计缓存读取量**，即每轮 `cache_read_input_tokens` 累加。
  每一轮都会把整段上下文再从缓存里读一遍，所以增长很快，长会话很容易到**几十 M**。
- `'context'`：**当前上下文占用**，不会超过模型窗口，量级是**十万到百万**，压缩或清空后会回落。

两者通常差一到两个数量级。想要接近「几百 k」的读数，用 `'context'`。

## 安装与卸载

本目录的上一级是一个本地 marketplace（`aethor-mods`），`usage-bar` 是其中的插件。

```bash
# 添加 marketplace（把路径换成 claude-mods 文件夹的实际位置）
claude plugin marketplace add "<path>/claude-mods"

# 安装（默认装到用户级，即所有会话生效）
claude plugin install usage-bar@aethor-mods

# 临时禁用 / 重新启用
claude plugin disable usage-bar@aethor-mods
claude plugin enable usage-bar@aethor-mods

# 卸载
claude plugin uninstall usage-bar@aethor-mods
```

也可以在会话里用 `/plugin` 界面操作。不想装 marketplace 时，可用 `claude --plugin-dir <path>/usage-bar` 只在当次会话加载。

## 许可证

MIT，见 `LICENSE`。
