# Atoms Demo · 一句话生成可运行的网页应用

> 在线体验：**https://atoms-demo-writing-test.ctq2013.workers.dev**（不用登录，可以直接点「游客体验」）

输入一句需求，多个智能体协作生成一个**能打开、能点、能存数据**的单文件网页应用。生成结果在沙箱里实时预览，可以继续用对话做增量修改、回滚版本、下载或分享，也能发布到作品广场。

```
① 一句话需求 → ② Planner 拆解 → Engineer×N 赛马编码 → QA 校验打分择优
            → ③ iframe 沙箱实时预览 → ④ 项目 / 版本 / 对话 / 任务状态全部落库
```

## 功能一览

| 模块 | 说明 |
| --- | --- |
| 注册 / 登录 / 游客 | 用户名密码注册（PBKDF2 哈希），也可以一键游客体验；游客之后能**升级为正式账号，项目不丢** |
| 多智能体流水线 | 📋 Planner 把需求拆成结构化规格 → 💻 Engineer 编码 → 🧪 QA 做静态校验并评分；过程（阶段、实时代码流、重试日志、计时）全程可见 |
| **赛马模式（亮点）** | 1–3 路工程师并行（不同设计取向和温度；模型可选 DeepSeek / GLM / 混合，混合时各路交替用两个模型），错峰启动防 429。按可解释的 9 项评分自动择优，悬停能看到细项；落选方案保留为「候选」，可以一键采用。首个方案合格后，其余赛道有 50s 宽限，超时就提前收敛，避免拖慢整体 |
| 对话式**增量**迭代 | 模型只输出 SEARCH/REPLACE 补丁，在本地应用，不会全量重吐。补丁必须全部命中，QA 也要通过才落库（原子性），失败时保留上一版。用所选模型出补丁，补丁不合格再自动换另一个模型重试。每个任务限时 120s，可随时取消，前端显示计时 |
| 运行时自愈 | 预览 iframe 捕获 JS 运行时错误后回传，可点「让 AI 修复」走增量修复 |
| 版本管理 | 每次生成、修改、采用、回滚都会产生新版本，历史不覆盖；任何版本都能预览或回滚 |
| 预览沙箱 | `sandbox` iframe，不给同源权限，生成的代码拿不到本站登录态；注入的 Storage 桥让沙箱内的 `localStorage` 照常可用，并按项目持久化，**刷新后应用内数据还在** |
| 分享 / 导出 / 广场 | `/s/:id` 独立分享页（CSP sandbox 隔离）；下载独立 HTML；公开到作品广场，他人可 Fork 后继续修改；广场预置 5 个官方示例，打开第一眼就有东西看 |
| 永不白屏（四层防线） | 节流（错峰）→ 重试（指数退避 1s/2s/4s + 抖动，最多 3 次）→ 备用模型通道（自动切到另一个模型）→ **内置模板降级**（5 套手写的完整可用模板，加上规则引擎做「换色、深色、改标题、字号、圆角」类修改）。前端标注「AI 生成 / 备用模型 / 演示模式」 |
| 故障演练 | 生成选项里可以手动模拟「主模型 429」「全部模型不可用」，现场验证降级链路；也可以勾选「演示模式」完全不调用模型 |
| 任务状态落库 | 生成任务在 Durable Object 内执行并写库（不受 Worker 单请求 CPU 限制），刷新页面能自动恢复进度；心跳超时的任务自动标记中断 |

## 技术栈

- **运行平台**：Cloudflare Workers（免费、自带 https、不需要备案），同一个 Worker 托管静态前端和 API
- **数据持久化**：Durable Object 内置 SQLite，强一致、随部署持久保存，不存在“免费实例重启丢库”的问题
- **大模型**：Anthropic Messages 兼容接口（`/v1/messages` 流式 SSE），白名单内两个模型，前端「🧠 模型」下拉选择：
  - `deepseek-v4-flash`（默认）
  - `glm-5.3-flash`（推理较慢，长需求通常 60–70s）
  - 「混合」：赛马各路交替使用两个模型，由 QA 评分择优
  - Planner / Engineer / Editor 都用所选模型；调用失败自动切到另一个模型，两者都不可用再降级到模板
  - 模型名放在 `wrangler.toml` 的 `[vars]`（`MODEL_DEEPSEEK` / `MODEL_GLM`）；后端只接受这两个，其他取值一律回落到默认
  - 接口地址和密钥只通过 `wrangler secret put ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 注入，**仓库和代码里没有任何 Key**
- **前端**：原生 ES Module + CSS，不需要构建；后端是原生 JS，测试用 Node 内置 `node:test`

## 目录结构

```
src/
  index.js            # Worker 入口：路由、鉴权、SSE 流式任务、分享页
  store.js            # Durable Object(SQLite)：用户/会话/项目/版本/消息/任务 + 预置示例
  agents/
    pipeline.js       # Planner → Engineer×N(赛马) → QA/Judge；Editor 增量迭代；降级兜底
    llm.js            # 流式调用、首包/停滞/总预算超时、取消、重试退避、备用通道、故障演练
    prompts.js        # 各智能体提示词
  lib/
    patch.js          # SEARCH/REPLACE 补丁解析与应用（精确 + 宽松行匹配）
    qa.js             # 静态 QA（截断/结构/脚本闭合）+ 可解释评分
    designSystem.js   # atoms-ui 基础样式库：生成后注入，统一视觉下限、缩短模型输出
    auth.js html.js
  templates/          # 5 套降级模板（看板/房贷计算器/个人主页/番茄钟/通用记录）+ 规则引擎
public/
  index.html app.js styles.css
  shim.js             # 预览沙箱 Storage 桥 + 运行时错误回传（前后端共用）
test/core.test.js     # 单元测试（补丁、QA、模板、规则修改、沙箱注入、设计系统）
docs/笔试说明文档.md   # 提交用的说明文档草稿
screenshots/          # 线上自测截图
```

## 本地运行

需要 Node.js ≥ 22，以及一个 Cloudflare 账号（免费版即可）。

```bash
npm install
npm test                 # 单元测试
npx wrangler login       # 首次使用时登录 Cloudflare
npm run dev              # 本地开发：http://localhost:8787（模型接口配置写在 .dev.vars，已被 .gitignore 排除）
npx wrangler secret put ANTHROPIC_BASE_URL     # 首次部署前配置模型接口
npx wrangler secret put ANTHROPIC_AUTH_TOKEN
npm run deploy           # 部署到 <name>.<subdomain>.workers.dev
```

- 没有模型接口时（未配置 Secret、或 `wrangler.toml` 里设 `AI_DISABLED = "1"`），或者在页面勾选「演示模式」，整个流程照样能跑完并出预览。
- 本地开发如需真实模型，在 `.dev.vars` 里写 `ANTHROPIC_BASE_URL=...` 和 `ANTHROPIC_AUTH_TOKEN=...`（不要提交）。

## 设计思路与关键取舍

1. **先保证“链接活着、闭环跑通、不会白屏”，再堆亮点。** 选 Workers + Durable Object(SQLite)，一次部署就同时解决 https 访问和持久化存储，没有冷启动、免费实例休眠、临时文件系统这类常见坑；模型密钥只放在 Worker Secret 里，不进仓库。
2. **产物是单文件 HTML。** 可以直接用 iframe 运行，也能下载后双击打开，最容易验证“真的能跑”。代价是不支持多文件或后端工程，这是有意的范围控制。
3. **只把赛马做深。** 赛马最能体现 Atoms 的特点：用并行和择优换质量与稳定性。评分规则可解释、可复现，没用 LLM 当评委，省额度也省时间；代价是对“视觉美观”只能间接衡量，所以加了设计系统注入来拉齐视觉下限。
4. **迭代走真增量。** 输出 token 少，不会撞上限、不会卡死；配合原子落库和版本快照，“改一次崩一次”的问题从机制上就规避了。
5. **安全隔离。** 生成的代码属于不可信内容，所以预览和分享页都放在无同源的沙箱里运行，持久化通过宿主桥接实现。

## 排障记录

| # | 遇到的坑 | 定位过程 | 解决方式 | 验证结果 |
| --- | --- | --- | --- | --- |
| 1 | 笔试飞书文档用 curl 拿不到内容 | 返回的是 passport 登录页 HTML（含 `window.passportSettings`） | 改用无头 Chrome 渲染，逐块滚动采集正文 | 拿到完整题目，并与官方避坑指南交叉核对 |
| 2 | `wrangler deploy` 报 “requires Node.js ≥ 22” | 本机 Node 是 v20 | 下载 Node 22 便携版来跑 wrangler，`package.json` 里声明 `engines` | 部署成功 |
| 3 | 刚部署完访问返回 `error code: 1101` | 用 `wrangler tail` 看实时日志，后续请求恢复正常，判断是部署传播期间的瞬时异常 | 加上 `observability` 日志；之后部署完都等几秒再验证 | 后续访问全部正常 |
| 4 | 调试用的 API Token 没有 D1/KV 权限（`Authentication error`） | 逐个调接口确认只有 Workers Scripts 权限 | 改用 **Durable Object 内置 SQLite** 做持久化，它随脚本迁移创建，不需要额外权限 | 刷新、重部署后数据都在 |
| 5 | 赛马时 B 路模型连续出现「输出停滞」，整个任务拖满 120s | SSE 日志显示 A 路 57s 完成，B 路两次 35s 无数据 | ① 加入“首个合格方案出现后宽限 N 秒就提前收敛”；② 每条赛道都有可 race 的中止器（取消或收敛时立刻生效，不用等读超时） | 2 路赛马总耗时从 120s 降到 60–75s |
| 6 | 增量修改耗时 85s，不符合“轻量修改 1 分钟内返回” | 推理型模型补丁小但首包慢 | 补丁走精简提示与小 max_tokens；补丁未全部命中就自动换另一个模型（原子性：部分命中也不落库） | 小改动约 8s，加功能类 40–65s |
| 7 | 模型的补丁 “3 处未匹配已忽略” 仍被落库，可能产生半成品 | 查看 SSE 日志里的 failed 计数 | QA 闸门改为“补丁必须全部命中”，否则整体不落库或升级模型 | 单测覆盖补丁失败不破坏原文 |
| 8 | 某模型的产物分数更高，实际观感却更差 | 分项分数显示两者都拿满结构、交互、持久化分 | 评分加入交互丰富度、二元组需求覆盖、实现完整度，在注入设计系统前打分 | 截图对比后，评分与观感一致 |
| 9 | 注入的基础样式库也定义了 `--primary`，规则换色改错了位置 | 检查生成结果里的 `--primary` 出现位置 | 规则换色改为全局替换；Editor 修改前先剥离基础样式库、落库前再注入 | 换色后线上预览颜色正确 |
| 10 | sandbox iframe（无同源）里 `localStorage` 抛 SecurityError，生成的应用存不了数据 | 在预览控制台复现 | 注入 Storage Proxy 垫片，通过 postMessage 回传宿主按项目持久化 | E2E：在预览里新建任务 → 刷新 → 任务仍在 |
| 11 | 切换到 Anthropic 兼容接口后，线上任务一跑就报 `exceededCpu` | `wrangler tail` 显示 Worker 请求 CPU 35ms，超过免费档 10ms；本地正常 | SSE 解析里思考增量只计数不做 JSON 解析；整个生成任务移到 Durable Object 内执行，Worker 只做鉴权和转发 | 2 路赛马、编辑、取消全部跑通，无 CPU 超限 |
| 12 | 两个模型输出被截断 / 正文为空 | 直连接口测试：`thinking:{type:"disabled"}` 等参数都无效，思考 token 占用 max_tokens | 调大 max_tokens（Planner 2500 / Engineer 12000 / Edit 6000），提示词限制产物约 12000 字符 | 产物完整闭合到 `</html>` |
| 13 | GLM-5.3 Flash 长需求 100s 内只思考、不出正文，触发「输出停滞」 | 直连统计：约 1.2 万个 thinking_delta、0 个 text_delta | 提示词要求“思考不超过 3 句话、立即输出”；思考期间也向前端推送进度；失败时自动切到 DeepSeek | 思考量降到约 1600 个 delta，房贷计算器单路 70s 完成（87 分） |
| 14 | 生成的应用里弹窗一打开就显示 | 查看产物：模型用 `.active` 类控制显示，但基础样式库把 `.modal-mask` 默认设为 `display:flex` | `.modal-mask` 改为默认隐藏，`.open/.active/.show` 时显示，并补充 `[hidden]` 规则；提示词写明用法 | 新生成的记账本、单词卡弹窗默认隐藏 |

**AI 使用说明**：开发全程用 AI 编码代理辅助，包括方案设计、代码编写、模型对比实验和排障方向。所有结论都在线上实测或单测里验证过（见 `screenshots/` 和 `npm test`）。

## 已知限制

- 两个模型都默认开启思考（thinking），接口侧无法关闭；GLM-5.3 Flash 思考更久，长需求单路约 60–70s，偶尔仍会因停滞切到备用模型。
- 生成结果的 QA 是静态检查，个别运行时错误（如变量提前引用）要靠预览捕获后点「让 AI 修复」。
- 生成的应用限定为单文件前端，不支持多文件工程、npm 依赖或后端代码。
- 分享页处于强隔离沙箱，应用内数据只保存在内存里（站内预览和下载的独立 HTML 都能持久化）。
