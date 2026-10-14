# dsh-anime-companion · DSH 动漫伴侣

一个 DSH（DeepSeek Harness）双半（Cordis）美化插件：**可换主题、可换形象、会朗读**。
主题换肤、Live2D 形象、TTS 朗读全部在本地完成，**不经过大模型，零 token**。

## 功能

| 模块 | 说明 |
| --- | --- |
| 主题换肤 | 仅覆盖 `--dsw-alias-*` 语义 token，light/dark 双值，切换持久化，按签名去重防 `theme/change` 重入 |
| 启动动画 | 经 `tapIndex` 注入首屏 CSS 动效 + 加载文案，客户端启动后移除 |
| Live2D 形象 | 右下角 Canvas 浮动层，可拖拽、可开关、指针避让、不遮挡输入区 |
| 换角色 | `models/<角色>/manifest.json` 模型包协议；设置里切换即热重载 |
| 自动朗读 | 捕获最终回复**正文**，跳过 reasoning 与 tool_use，按句入队 |
| TTS 回退 | 浏览器 `speechSynthesis` → Edge TTS → Piper，自动降级且不静默 |
| 音量口型 | Edge/Piper 走 Web Audio `AnalyserNode` 计算 RMS 驱动 `ParamMouthOpenY` |
| 状态表情 | 思考 / 搜索 / 生成 / 完成 映射到表情与动作 |
| 设置中心 | 角色、主题、语音、语速音高、朗读模式，经 Host 写入 profile 配置（新版 DSH 落到 `cordis.patch.yml`，旧版为 `settings.yaml`） |
| 兜底 | 会话 `sessions` 服务 + DOM `MutationObserver` 双通道；无 Cubism Core 时用 PNG/SVG 轻量形象 |

## 安装与部署

DSH 插件安装底层是 pnpm：`dsh plugin --profile <name> add <spec>` 里的 `<spec>`
可以是**本地目录、npm 包名、或 git URL/GitHub 简写**。`<profile>` 取
`web`（浏览器版）或 `desktop`（Electron 桌面版），按你的终端二选一。

### 方式一：从 GitHub 一键安装（其他设备最省事）

```bash
# 浏览器版
dsh plugin --profile web add github:Murphy1134/dsh-anime-companion
# 桌面版
dsh plugin --profile desktop add github:Murphy1134/dsh-anime-companion
```

等价的完整 URL：

```bash
dsh plugin --profile web add https://github.com/Murphy1134/dsh-anime-companion.git
```

pnpm 从 git 拉取后会运行本包的 `prepare` 脚本自动 `npm run build` 产出
`lib/`，随后 DSH 即可加载。装完**重启 DSH** 生效。

> 若你的环境不允许安装时跑 `prepare`（依赖未装好导致 build 失败），改用方式二手动 build 一次即可。

### 方式二：本地源码构建后安装（开发 / 自定义主题角色）

```bash
git clone https://github.com/Murphy1134/dsh-anime-companion.git
cd dsh-anime-companion
npm install        # 或 pnpm install
npm run build      # 产出 lib/index.mjs（Host）与 lib/client.js（Client）
# 安装到指定 profile（填本目录绝对路径）：
dsh plugin --profile web      add /绝对路径/dsh-anime-companion
dsh plugin --profile desktop   add /绝对路径/dsh-anime-companion
```

### 方式三：应用内 GUI

DeepSeek Harness → 设置 / 插件管理 → 添加本地插件，选择包含 `cordis.patch.yml`
的本目录即可；也可在输入框粘贴上面的 git URL。

### 卸载 / 升级

```bash
dsh plugin --profile web      remove dsh-anime-companion
dsh plugin --profile web      add    github:Murphy1134/dsh-anime-companion   # 升级到最新
```

启动 `dsh web` 或桌面端后：右下角出现伴侣；左下角 ⚙ 打开设置，🙈 显隐。

> 真 Live2D 需另放 `vendor/live2dcubismcore.min.js`（见下文）；缺 Core 自动用
> SVG 轻量形象兜底，主题、设置、TTS 等其余功能不受影响。

## 关于资源 404（Electron 桌面端）

`dsh web` 下路由为同源 `/api/anime-companion/...`；DSH Desktop 页面跑在
`dsh-app://` 自定义协议下，根相对路径会被解析成 `dsh-app://app/api/...` 而落空。
客户端 `src/shared/protocol.ts` 会在启动时用候选前缀并发探测 `/skin.json`
（`/api/...`、`/app/api/...`、注入值），命中即缓存；所有资源一律使用探测出的
**绝对地址**。若仍 404，优先确认 Host 半已成功注册路由（见控制台
`[anime-companion] API base → …`）。

## 增加 Live2D 角色（真正的 Cubism 模型）

1. 把 Live2D 官方的 `live2dcubismcore.min.js` 放入 `vendor/`（受 Live2D 许可
   约束，插件不内置）。Host 检测到后会自动经 index 注入。
   - **未放 Core 也不会导致启动失败**：pixi / pixi-live2d-display 仅在检测到
     `window.Live2DCubismCore` 后才动态 `import`，模块激活阶段不碰 Cubism；
     缺 Core 时自动降级为 PNG/SVG 轻量形象（见示例 `models/example`），其余
     主题、设置、TTS 功能不受影响。
2. 新建 `models/<角色>/`，放入 `xxx.model3.json`、贴图、moc3、motion、expression。
3. 写 `manifest.json`：
   ```json
   {
     "id": "haru",
     "name": "Haru",
     "kind": "live2d",
     "model": "haru_greeter_t03.model3.json",
     "image": "preview.png",
     "expressionMap": {
       "thinking": "F01",
       "search": "F01",
       "generating": "F00",
       "done": "F02",
       "failed": "F03"
     }
   }
   ```
   表情名以模型实际 expression 为准；缺失会被静默忽略。

## 启用 Edge / Piper

- **Edge TTS**：默认即用（联网，不消耗大模型 token）。音色填 `zh-CN-XiaoxiaoNeural`
  等。若完全离线，浏览器内置 `speechSynthesis` 仍可用。
- **Piper**：在 `cordis.patch.yml` 的 `config` 里填 `piperBin` 与 `piperVoiceDir`
  （目录下放 `*.onnx` 与 `*.onnx.json`）。设置面板会通过 `/piper-voices` 发现音色。

## 主题包协议

`themes/<id>/theme.json`：

```json
{
  "id": "my-theme",
  "name": "我的主题",
  "tokens": {
    "light": { "--dsw-alias-brand": "#e86a9e" },
    "dark":  { "--dsw-alias-brand": "#ff8fc0" }
  }
}
```

- 只覆盖你要改的语义 alias；未列出的 token 沿用官方默认。
- 同名 `style.css` 可放额外轻增强（滚动条、选中色、聚焦光晕等），颜色一律引用
  `--dsw-alias-*` 变量，自动随外观切换。
- 不同 DSH 版本的 alias 命名若有差异，以官方设计 token 表为准替换键名。

## 适配 DSH 演进

代码中所有随版本可能变化的调用点都标注了
`// TODO: 根据 DSH 当前版本适配 API`，主要在：
- settings：新版 DSH（0.2.0+）要求插件**导出 Cordis `Config` schema**（`@deepseek-ai/schemastery`），
  且可在运行时改的字段标记 `.volatile()`，`settings.replace(ns, …)` 才允许写（ns 即入口 id）；
  本插件据此在 `src/index.ts` 导出 `Config`，并用 `configure({auto:false}, 主fiber)` 关闭自动页。
  老版本（仅 `settings.register`）保留能力探测，命名空间为 `ui-anime-companion`。
  // TODO: 根据 DSH 当前版本适配 API。
- web server：`webServer.register/tapIndex`（部分版本服务名是 `httpServer`）。
- 主题：`ctx.theme` 的 `registerTheme/overrideTokens` 方法名（CSS 注入始终兜底）。
- 会话：`sessions` 快照的消息数组字段；DOM 选择器（capture 层多候选兼容）。
