# 学习屋 · 实时聊天与文件柜

零月费的熟人小圈子站点：实时聊天、历史搜索、文件上传下载。全程跑在 Cloudflare
免费额度内，**不需要绑卡、不需要备案**（需要一个域名，首年约 1 元、续费约 120 元）。

访问地址：**`https://chat.example.com`**（自定义域名，直连 Worker，推荐）

备用地址：`https://your-proxy.pages.dev`（经 Pages 代理转发，供 workers.dev 被
阻断的线路使用）

> **上面这些是占位符。** 部署你自己的实例时，把文中出现的 `example.com`、
> `YOUR-SUBDOMAIN`、`your-proxy` 换成你自己的域名和 Cloudflare 项目名。
> 需要替换的位置包括 `functions/[[path]].js` 里的 `UPSTREAM` 常量（线上代理转发
> 的上游地址）、`wrangler.jsonc` 里的 Worker 名称，以及 `tools/` 下各脚本的默认
> 参数——测试脚本的地址是命令行参数，不替换也能用，只要运行时传自己的地址。

**为什么要自定义域名**：`workers.dev` 在部分网络被直接阻断（TCP 443 超时），而
自定义域名解析到 Cloudflare 的通用 IP 段（`104.21.x` / `172.67.x`）可正常访问。
两条入口实测速度相当，见下文对比。

## 为什么有 Pages 代理

实测发现部分网络会阻断 `workers.dev`（TCP 443 直接超时），但 `pages.dev` 同一台
机器上可以正常访问：

```
workers.dev          timeout       阻断
1.1.1.1              timeout       阻断
pages.dev            connect 0.26s 可通
cloudflare.com       http 200      可通
104.16.132.229:443   可通          Cloudflare 通用 IP 段
```

所以前端静态文件直接部署在 Cloudflare Pages 上，`/api/*` 由 Pages Function 转发
到 Worker。请求始终留在 `pages.dev` 同源之下，Cookie 与 WebSocket 升级行为和在
Worker 上完全一致。

```
浏览器
  │  https://chat.example.com
  ├─ 静态资源 ─────────────► Pages 静态托管
  └─ /api/* ──► Pages Function ──► Worker ──► Durable Object
                                  │            ├─ ChatRoom  消息/文件元数据/配额
                                  │            └─ BlobStore 每个文件的字节
                                  └─ 会话、鉴权、分片接收、下载流式转发
```

Worker 本身不依赖这个代理。它同时挂在两个域名上：自定义域名 `chat.example.com`
（解析到 Cloudflare 的通用 IP 段，线路可达）与 `cf-chat.YOUR-SUBDOMAIN.workers.dev`
（在被阻断的网络下不可达，仅作参考）。

**拿到自定义域名后应优先使用它**：`你 → Worker → DO` 只有一跳，而经 Pages 代理是
`你 → Pages → Worker → DO` 两跳，少一跳就是少一次转发开销。Pages 入口保留作为备用。

## 存储方案

**不使用 R2。** R2 免费额度虽然有 10 GB 且出口免费，但开通时必须绑定支付方式。

改用 Durable Object 自带存储，免费计划给账号 5 GB，无需任何支付验证：

| 对象 | 存放内容 | 说明 |
| --- | --- | --- |
| `ChatRoom` | 消息、文件元数据、限流计数、配额统计 | 单个 DO，键 `main` |
| `FileStore` | 上传会话（每个上传一行） | 单个 DO，键 `global` |
| `BlobStore` | 文件的全部字节 | 每个文件一个独立对象，键 `blob:<channel>` |

每个文件的数据落在自己的 BlobStore 对象里，因此总量受账号的 5 GB 限制，而不是
单个对象 1 GB 的限制。单文件上限设为 1 GiB，界面配额上限 4 GB（留 1 GB 余量）。

## 免费额度对照

| 项目 | 免费额度 | 本项目的用量特征 |
| --- | --- | --- |
| Workers 请求 | 10 万/天 | API 调用与分片写入，数千级 |
| DO 请求 | 10 万/天 | 入站消息按 20:1 折算，出站广播不计费 |
| DO 计算时长 | 13,000 GB-s/天 | 靠 WebSocket Hibernation 把空闲连接压到零 |
| DO 行读取 | 500 万/天 | 读消息、读分片 |
| DO 行写入 | 10 万/天 | 每条消息一行，每个分片块一行 |
| DO 存储 | 账号 5 GB | 配额上限设为 4 GB |

心跳间隔是唯一需要守的约束：客户端固定 30 秒。压到 5 秒会让入站消息折算后的
请求数明显上升。

## 本地开发

```bash
pnpm install
pnpm build          # 先生成 web/dist，Worker 才能提供静态资源
pnpm dev            # Vite watch + wrangler dev 并行
```

打开 `http://127.0.0.1:8787`。本地由 Miniflare 模拟 Durable Object，
数据落在 `.wrangler/`，重启 `wrangler dev` 不会丢消息。

`.dev.vars` 里的 `SESSION_SECRET` 仅供本地使用，生产走 `wrangler secret put`。

**一个重要的本地环境坑**：`wrangler dev` 的热重载**不会更新已存在的 Durable Object
实例**，改动 DO 代码后必须完全停掉进程（确认 `workerd` 进程数归零）再启动，
否则你会对着旧代码调试，并且看到互相矛盾的日志。

## 部署

```bash
# 1. 首次：登录与密钥
pnpm exec wrangler login
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
pnpm exec wrangler secret put SESSION_SECRET    # 粘贴上一步的输出

# 2. 部署 Worker（含静态资源）
pnpm run deploy

# 3. 部署 Pages 代理（必须在项目根目录运行）
pnpm exec wrangler pages deploy web/dist --project-name cfchat-app
```

第 3 步必须在**项目根目录**执行：Pages 只识别根目录下的 `functions/`，用
`--cwd`、`pages_build_output_dir` 或子目录部署都不会让 Functions 生效，
表现是 API 返回 200 但内容是 `index.html`。

`SESSION_SECRET` 必须设置。缺失时 HMAC 签名每次都失败，表现为每次请求都签发新
身份——聊天看着正常，但搜不到自己的历史，而且不会报错。

本地 `.wrangler/` 与线上数据完全独立，互不同步。

## 运行时的硬限制

这套代码在本地运行时上踩过几个坑，写下来避免重复排查。所有跨 Durable Object
的调用都受这些限制约束：

**RPC 多参数会被压扁。** 传四个参数的调用，接收端只拿到第二个，其余全错位。
所以所有 RPC 方法统一只接收单个对象参数。

**RPC 参数含超大字符串时整个参数对象消失。** 一个字段过长会导致接收端拿到
`undefined`，且不报错。所以大负载（文件分片）切成 32 KB 的块逐次传输。

**Durable Object 的 fetch 会剥掉请求信息。** 经 `stub.fetch()` 到达对象时，
query 参数、自定义 header、URL 子路径、body 前缀都会被丢弃或改写，只有完整的
body 能原样送达。这就是为什么所有标识符都走参数而不是 URL。

**绑定必须与类匹配。** 取 BlobStore 存根必须用 `BLOB_STORE` 绑定，用
`FILE_STORE` 会拿到 FileStore 对象，报错是「方法不存在」，容易误判成方法没定义。

**WebSocket Hibernation 是免费的关键。** 必须用 `ctx.acceptWebSocket()`，
不是 `ws.accept()`，否则空闲连接会持续产生时长计费。

**本地不触发定时任务。** Miniflare 不会自动跑 cron，手动触发用
`curl "http://127.0.0.1:8787/cron/scheduled"`（wrangler 4）或
`curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"`。线上按 `17 4 * * *`
执行回收。

**经 Pages 代理的 WebSocket 会偶发丢帧。** 广播帧有约三成的概率不送达某个客户端，
所以在线人数偶尔会短暂显示旧值。服务端对新连接和断开各做了一次延迟补发，把影响
压到偶发；这是代理层的特性，不是应用逻辑错误。实时聊天消息本身不受影响，因为
消息以数据库为事实来源，客户端失联重连后会通过 `hello` 里的 `recent` 补齐。

**改接口响应必须同步改前端。** 文件分片的响应体从对象存储时代的
`{ partNumber, etag }` 变成了 `{ ok, partNumber, chunks, received }`，前端
`web/src/lib/upload.js` 里有一条 `data.ok !== true` 的校验。测试脚本按新契约断言，
所以**测试全绿不代表浏览器能上传**——改完协议要跑
`node tools/probe-part-contract.mjs`，它按浏览器的断言校验响应。

**大文件上传会压垮 Durable Object，返回 503。** 每次分片写入都要在 Worker 做
base64 编码、在 DO 里写 SQLite，并发一高队列就积压，边缘返回 503（HTML 错误页，
不是应用报错）。实测临界点：

```
并发 8 + 256KB 分块    32MB 上传在第 10 个分片开始 503
并发 4 + 128KB 分块    103MB 上传全程通过（99.8 秒）
```

所以并发默认 4、分块 128 KB 不是随意取的，调大了会重新触发 503。前端把 503
当作「过载」而非普通失败，用 1.5s×n 的长退避重试 5 次；如果直接在原队列上重试，
只会再撞一次 503。

上传大小梯度可用 `node tools/probe-upload-limits.mjs` 复测，它从 16MB 递增到
103MB，能直接看出临界点是否被改坏。

**清空数据会打断正在进行的上传。** `/api/clear` 会删掉上传会话，此时客户端手里
的 uploadId 立即失效。前端遇到 `session_lost` 会自动重新初始化并重传一次，所以
表现为进度条重来；但如果有人在传大文件，最好等它传完再清。

## 上传下载速度

实测（20 MB 文件，并发 8 个分片，经 Pages 代理）：

| 操作 | 速度 | 103 MB 文件约需 |
| --- | --- | --- |
| 上传 | 4 到 5 MB/s | 20 到 25 秒 |
| 下载 | 0.3 到 0.4 MB/s | 4 到 6 分钟 |

上传走的是分片加并发，所以快；下载慢是因为数据要经 Durable Object → Worker →
Pages 三层转发，且每层都要做 base64 编解码（跨对象 RPC 无法直接传二进制）。

调过的参数：分片 2 MiB、RPC 分块 256 KiB、前端并发 8、下载窗口 4 MiB。把下载
窗口放大或把数据块合并后再输出，实测都没有改善——瓶颈是逐跳转发的固定开销，
不是窗口大小。

**如果下载速度是硬需求**，出路是换存储后端：升级 Workers 付费计划后用 R2
（出口免费且直出），或改用国内对象存储（需备案）。

### 自定义域名与代理入口的对比

绑定 `chat.example.com` 后测过两条入口（8 MB 文件，各两次）：

| 入口 | 跳数 | 实测速度 |
| --- | --- | --- |
| `chat.example.com` 直连 Worker | 一跳 | 0.31 / 0.53 MB/s |
| `your-proxy.pages.dev` 经 Pages 代理 | 两跳 | 0.35 / 0.62 MB/s（历史峰值 4.61） |

**差异落在噪声范围内 —— 少一跳没有带来提速。** 这排除了「代理层是瓶颈」的假设，
把原因锁定在跨境链路本身：下载流被切成约 615 个 14 KB 的块，每块都要一次往返，
以跨境 RTT（约 40 ms）计就是 25 秒左右，与实测吻合。

也就是说，只要数据经 Cloudflare 回源到境内，速度就受这个物理距离限制，换入口、
调窗口、改并发都改变不了。**要质变只能把数据搬到境内**（国内服务器或对象存储）。

## 空间配额

文件柜顶部实时显示占用与剩余：`1 个 · 8.00 MB / 4.00 GB`，下面一条进度条，
再下面是「剩余 3.72 GB」。达到 80% 变黄，达到 100% 变红。

超限保护分两道：前端用已知文件大小先做一次检查，明显放不下的直接提示；真正的
判定在服务端 `POST /api/up/init`，超限返回 **507** 且不创建上传会话。单文件
硬上限 1 GiB，超出返回 `too_large`。

占用统计只算 `status = 'ready'` 的记录，并且**删除时立即把该记录的字节数归零**，
所以删掉文件后剩余空间立刻恢复。墓碑记录不占配额。

## 删除行为

删除同时改三处：BlobStore 里的字节立即销毁、文件柜隐藏、聊天记录里的卡片变成
灰底划线的「已删除 · 不可下载」。删除事件通过 WebSocket 广播，其他人开着页面
时会实时失效，不需要刷新。

记录保留为墓碑（只存文件名和大小），刷新或换设备后聊天记录仍显示「这里曾经有
个文件」，而不会卡片莫名消失。字节回收失败的残留由每日定时任务重试。

当前没有账号体系，删除不校验上传者，任何进入房间的人都能删任何文件。这是给熟人
小圈子的取舍：加权限校验需要先有账号，而账号会推翻「打开就能聊」的前提。代之以
删除限流和删除者记录。

重复删除是幂等的：第二次调用返回成功而不是报错，因为文件已经处于用户想要的状态。
同理，删除一个记录里已不存在的文件不会弹出错误。

**清空**按钮在搜索栏右侧，会一次删除所有消息、聊天记录里的全部文件和文件柜里的
文件，删除前有二次确认。它走 `/api/clear`，与删除共用同一个限流桶（每分钟 20 次）。
这是破坏性操作且当前没有账号体系，所以防护完全依赖客户端确认对话框——如果站点要
开放给更大的圈子，这里需要先加鉴权。

## 文件存在哪里

本地开发由 Miniflare 模拟，数据落在磁盘上：

```
.wrangler/state/v3/do/cf-chat-ChatRoom/<hash>.sqlite    消息与文件元数据
.wrangler/state/v3/do/cf-chat-FileStore/<hash>.sqlite   上传会话
.wrangler/state/v3/do/cf-chat-BlobStore/<hash>.sqlite   文件字节（每文件一个对象）
```

所以 `.wrangler/` 就是你的数据库：删掉它等于删掉全部本地数据和文件，不是清缓存。

部署后数据全部在 Cloudflare 云端，不在你本机。本地测试上传的内容不会出现在
线上，需要在线上重新上传。

## 验证

脚本直接打真实接口，可指定任意环境（本地或线上）：

```bash
node tools/e2e.mjs https://chat.example.com 3   # 上传→广播→下载→Range→秒传→搜索→删除→回收
node tools/ws-test.mjs https://chat.example.com      # 握手→广播→历史→心跳→限流
node tools/presence-test.mjs https://chat.example.com # 在线人数精确序列
node tools/quota-test.mjs https://chat.example.com    # 用量增减、删除释放、超限拦截
node tools/clear-files.mjs https://chat.example.com   # 清空文件柜（保留聊天记录）
node tools/probe-roundtrip.mjs http://127.0.0.1:8787 300    # 逐字节往返校验
node tools/seed-ux.mjs http://127.0.0.1:8787                # 造正常/已删除两种文件看 UI
```

`e2e.mjs` 第二个参数是测试文件大小（MB）。已验证 3 MB 与 20 MB（分片上传），
下载内容逐字节比对一致。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/session` | 首次访问签发匿名身份 |
| GET | `/api/ws` | WebSocket 升级，`?token=` 可替代 Cookie |
| GET | `/api/history` | `since`、`limit`、`q` 增量或搜索 |
| GET | `/api/files` | 文件柜列表与容量，`q` 按文件名过滤 |
| POST | `/api/up/init` | 创建上传会话，返回分片几何 |
| PUT | `/api/up/part` | `?uploadId=&partNumber=` 上传一片 |
| POST | `/api/up/complete` | 完成上传并广播到聊天 |
| POST | `/api/up/abort` | 放弃上传 |
| DELETE | `/api/files/:id` | 删除文件并回收字节，重复调用幂等 |
| POST | `/api/files/purge` | 手动触发回收 |
| POST | `/api/clear` | 清空全部消息与文件（界面上是搜索栏旁的「清空」按钮） |
| GET | `/api/dl/:id` | 下载，支持 Range 续传 |
| GET | `/api/health` | 绑定与配置自检 |

限流按会话身份 + IP：发消息 20 次/分钟、上传初始化 10 次/分钟、下载 60 次/分钟、
搜索 30 次/分钟、删除 20 次/分钟。超限返回 429 或 WebSocket `error` 帧。

## 目录

```
src/worker/index.js       路由、会话、WebSocket 转发、分片接收、下载流式转发
src/worker/chat-room.js   消息与文件元数据中心，配额统计，Hibernation 广播
src/worker/file-store.js  上传会话、文件元数据、Blob 存储与读取
src/worker/auth.js        HMAC 会话令牌，无账号体系
functions/api/[[path]].js Pages 代理：/api/* 转发到 Worker
functions/[[path]].js     Pages 代理：其余路径转发到 Worker
web/src/App.jsx           聊天界面、文件柜、空间用量、上传进度
web/src/lib/upload.js     分片上传、断点续传、暂停恢复
web/src/lib/useChat.js    WebSocket 自动重连与心跳
tools/                    端到端验证脚本与开发辅助脚本
```

## 已知取舍

单文件上限 1 GiB、总量 4 GB，是 Durable Object 免费额度的硬边界。需要更大容量
时可选升级 Workers 付费计划（约 $5/月，单对象上限升到 10 GB 且账号总量不限），
或改用国内对象存储（需备案）。

下载经 Worker 与 Pages 双层转发，速度不如对象存储直出，但省去了域名和备案。

内容审核只做了基础防护：类型与大小限制、强制下载、`nosniff`、按 IP 限流。
没有机器审核，适合熟人小圈子。
