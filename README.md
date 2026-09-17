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

## 功能

- **实时聊天** —— WebSocket 推送，顶部显示在线人数
- **历史消息** —— 持久化保存，支持关键词搜索，按日期分组
- **文件上传** —— 2 MiB 分片并发上传，支持断点续传
- **文件下载** —— 浏览器原生下载，支持 Range 续传
- **文件柜** —— 列出全部文件（大小、上传者、下载次数），带实时容量条
- **共享公告栏** —— 顶部可编辑，改动通过 WebSocket 同步给所有人
- **一键清空** —— 只清空聊天记录，文件柜完整保留，其他人页面实时同步
- **删除即释放** —— 删掉文件立刻回收配额空间，无需等待

**没有账号体系。** 打开网页就能用，昵称自动分配（形如「路人7538」），会话保留
30 天。代价是任何进入房间的人都能删除任何文件、编辑公告、清空全部内容 —— 防护
只有限流。这个取舍是为了保住「打开就能聊」这个前提，见下文「删除行为」。

## 设计取舍

- **零月费** —— 全部跑在 Cloudflare 免费额度内，不需要绑定支付方式
- **不需要备案** —— 使用 Cloudflare 提供的域名，无需国内 ICP 备案
- **空闲连接不计费** —— 采用 WebSocket Hibernation API，闲置时对象休眠
- **依赖极少** —— 运行时只依赖 Hono，前端手写 React 未引入 UI 框架
- **不用 R2** —— 换取零支付门槛，代价是下载速度受限于对象存储的转发路径

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

所以前端构建产物直接由 Worker 提供（通过 `assets` 绑定托管），Pages 只做一层
全路径代理转发。请求始终留在 `pages.dev` 同源之下，Cookie 与 WebSocket 升级
行为和在 Worker 上完全一致。

```
                直连（推荐）                    备用
        https://chat.example.com       https://your-proxy.pages.dev
                    │                                │
                    │                                └─ Pages Function
                    │                                     全路径转发
                    ▼                                      │
                    └──────────► Worker ◄──────────────────┘
                                    │
                                    ├─► ChatRoom   消息、文件元数据、配额、公告
                                    └─► BlobStore  文件字节（按 channel 分散到独立实例）
```

两条入口最终命中同一个 Worker，区别只是备用入口中间多一跳。Worker 不依赖 Pages
也能独立工作，它同时挂在自定义域名和 `cf-chat.YOUR-SUBDOMAIN.workers.dev` 上 ——
后者在被阻断的网络下不可达，仅作参照。

**拿到自定义域名后应优先使用它**：客户端直连 Worker 只有一跳，而经 Pages 代理是
两跳。少一跳就是少一次转发开销，Pages 入口保留作为备用。

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
`undefined`，且不报错。所以大负载（文件分片）切成 128 KB 的块逐次传输 —— 这个
尺寸同时受另一个约束：块越大，Worker 单次请求的 base64 编码耗时越高，免费版
CPU 时间只有 10 ms。

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

**上传会话与聊天记录是相互独立的。** `/api/clear` 只删消息，不碰上传会话，所以
清空不会打断正在进行的上传。

前端的 `session_lost` 自动恢复机制仍然保留并生效 —— 上传会话可能因其他原因失效
（长时间中断、对象被重建、服务端数据被外部清理），此时客户端会自动重新初始化并
重传一次，表现为进度条重来而不是弹出错误。

## 上传下载速度

实测数据（8 到 20 MB 文件，经 Pages 代理，默认并发 4）：

| 操作 | 速度 | 说明 |
| --- | --- | --- |
| 上传 | 约 1 MB/s | 分片并发写入，较稳定；103 MB 约 100 秒 |
| 下载 | 0.05 到 4.6 MB/s | **波动极大**，典型值 0.3 到 0.6 |

**下载速度的剧烈波动是这条链路的固有特征**，同一个文件前后两次测能差 5 倍以上。
原因不在代码：下载流会被切成约 600 个 14 KB 的小块，每块都要一次往返，而数据要
经 Durable Object → Worker → Pages 三层转发，每层还各做一次 base64 编解码（跨
对象 RPC 无法直接传二进制）。以跨境 RTT 约 40 ms 计，`600 × 40ms ≈ 24 秒`，与
实测的中位区间吻合。

上传明显快于下载，因为上传是分片并发写入，而下载是单流读取，且多经一层代理转发。

**试过但无效的优化**：加大下载窗口、合并数据块输出、并发分片下载（反而更慢，
切碎后每个请求都要重付一次代理开销）、切换入口域名 —— 全部落在波动范围之内。

**想真正提升下载速度，只能改变数据路径**：把文件字节搬到境内对象存储，或升级到
Workers 付费计划改用 R2（出口免费且直连）。单纯在 Cloudflare 这一层调参数已经
没有空间了。

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

**清空**按钮在搜索栏右侧，**只删除聊天记录**，文件柜里的文件和已占用的配额都不受
影响，删除前有二次确认。它走 `/api/clear`，与删除共用同一个限流桶（每分钟 20 次）。

**为什么把两者分开**：聊天记录丢失后还能从上下文重建，文件删掉就是真没了 —— 一个
「清理对话」的动作不应该顺手销毁别人可能还要的文件。需要清理文件时，在文件柜里
逐个删除，每次删除会立即释放配额空间。

清空是破坏性操作，且当前没有账号体系，所以防护完全依赖客户端确认对话框。如果站点
要开放给更大的圈子，这里需要先加鉴权。

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
| POST | `/api/clear` | 清空聊天记录（文件柜与已占配额保留） |
| GET | `/api/notice` | 读取共享公告栏（无需会话即可读） |
| POST | `/api/notice` | 更新公告栏，广播给所有在线客户端 |
| GET | `/api/dl/:id` | 下载，支持 Range 续传 |
| GET | `/api/health` | 绑定与配置自检 |

限流按会话身份 + IP：发消息 20 次/分钟、上传初始化 10 次/分钟、下载 60 次/分钟、
搜索 30 次/分钟、删除 20 次/分钟、编辑公告 10 次/分钟。超限返回 429 或 WebSocket
`error` 帧。删除与清空共用同一个限流桶。

## 目录

```
src/worker/index.js       路由、会话、WebSocket 转发、分片接收、下载流式转发
src/worker/chat-room.js   消息与文件元数据中心，配额统计，Hibernation 广播
src/worker/file-store.js  上传会话、文件元数据、Blob 存储与读取
src/worker/auth.js        HMAC 会话令牌，无账号体系
functions/[[path]].js     Pages 代理：全部路径转发到 Worker（静态资源亦由 Worker 提供）
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

## 许可

[MIT](LICENSE) © 2026 梅赛德斯

可以自由使用、修改、分发和商用，只需保留版权声明。软件按原样提供，不附带任何
担保 —— 这包括数据丢失的风险，所以别把它当成唯一一份重要文件的存放处。
