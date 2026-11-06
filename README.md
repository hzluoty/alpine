<div align="center">
  <h2>nodejs-nezha · 静态网页 + 哪吒探针</h2>
  <p>单文件 Node 服务：对外提供一个静态首页（index.html），并在后台拉起哪吒探针 v0 / v1。<br/>不含任何隧道代理、订阅输出、节点生成逻辑。</p>
</div>

## 说明

* 适合 node 玩具平台、PaaS 与 Docker 部署。
* 玩具平台只需上传 `index.js` + `index.html` + `package.json`；需要 Docker 部署时再带 `Dockerfile`。
* 探针按系统架构（amd / arm）自动选择下载地址，主源失败自动切换备用源。
* 不填 `NEZHA_SERVER` / `NEZHA_KEY` 时只跑网页，不启动探针。
* 启动时只清理自身旧残留（`nezha-agent-<pid>-<seq>` / `nezha-v1-<pid>-<seq>` / `nezha-config-<pid>-<seq>.yaml` / `*.download`），且只删 90 秒前的文件，运行目录里的其它文件与其它实例正在用的文件不动。
* `NEZHA_PORT` 留空 = 哪吒 v1（`config.yaml` 模式）；填写 = 哪吒 v0（命令行参数模式）。
* 哪吒端口为 443 / 8443 / 2096 / 2087 / 2083 / 2053 之一时自动开启 TLS。

## 路由

| 路径 | 说明 |
|------|------|
| `/`、`/index.html` | 静态首页；`index.html` 缺失时返回 500，不伪装成成功 |
| `/health`、`/healthz` | 健康检查，返回 `ok` |
| 其它 | 404 |

## 📋 环境变量

| 变量名 | 是否必须 | 默认值 | 说明 |
|--------|----------|--------|------|
| `PORT` / `SERVER_PORT` | 否 | 3000 | 网页服务监听端口；非法值回落到 3000 并记日志 |
| `FILE_PATH` | 否 | `.npm` | 探针文件运行目录 |
| `UUID` | 否 | 内置固定 UUID | 该服务器唯一标识；多机部署必须各自覆盖，否则会互相覆盖 |
| `NEZHA_SERVER` | 否 | - | 哪吒 v1 填 `nz.abc.com:8008`；哪吒 v0 填 `nz.abc.com` |
| `NEZHA_PORT` | 否 | - | 哪吒 v1 留空；哪吒 v0 填写端口 |
| `NEZHA_KEY` | 否 | - | 哪吒 v1 的 `NZ_CLIENT_SECRET`；哪吒 v0 的 agent 密钥 |
| `NEZHA_URL` | 否 | `https://amd64.oooen.com` | amd64 探针下载主源 |
| `NEZHA_URL_BACKUP` | 否 | `https://amd64.ssss.nyc.mn` | amd64 探针下载备用源 |
| `NEZHA_URL_ARM` | 否 | `https://arm64.oooen.com` | arm64 探针下载主源 |
| `NEZHA_URL_BACKUP_ARM` | 否 | `https://arm64.ssss.nyc.mn` | arm64 探针下载备用源 |
| `SHOW_LOG` | 否 | `true` | `false` / `disable` / `no` 完全屏蔽日志，其余值显示 |

## 🚀 运行

```bash
# 本地运行
npm start

# 或直接
node index.js
```

后台常驻可用 PM2：

```bash
npm install -g pm2
pm2 start index.js --name page
pm2 logs page
```

## 🐳 Docker

镜像内应用目录固定为 `/app`，入口用**绝对路径**启动，与 `cwd` 无关：

```dockerfile
WORKDIR /app
COPY index.js index.html package.json ./
CMD ["node", "/app/index.js"]
```

```bash
docker build -t page .
docker run -d --name page -p 3000:3000 \
  -e NEZHA_SERVER=nz.abc.com:8008 \
  -e NEZHA_KEY=your-secret \
  page
```

* `HEALTHCHECK` 每 30s 探一次 `/health`；`EXPOSE` 与代码默认端口一致（仅代码持有默认值，镜像不再重复 `ENV PORT`）。
* `.dockerignore` 排除 `test/`、`.github/`、`node_modules/`，镜像只带运行所需的三个文件。
* 镜像构建见 `.github/workflows/build-docker-image.yml`，推送到 `ghcr.io/<owner>/nodejs:latest`。

## 🧯 部署故障排查

**`Error: Cannot find module '/tmp/index.js'`**
启动命令的 `cwd` 与 `index.js` 所在目录不一致（旧 Dockerfile 曾用 `WORKDIR /tmp` + 相对入口，平台一旦不把文件放进 `/tmp` 就必错）。按顺序排查：

```bash
# 1) 确认入口文件确实存在
ls -l /app/index.js          # 镜像内
ls -l ./index.js             # 玩具平台部署目录

# 2) 确认启动命令指向文件本身，而不是依赖 cwd
node /app/index.js           # 推荐：绝对路径

# 3) 确认三件套同目录
ls index.js index.html package.json
```

* 玩具平台：上传 `index.js` + `index.html` + `package.json`，启动命令填 `node index.js`，**工作目录必须是这三个文件所在目录**。
* 自建 Docker：直接用本仓 `Dockerfile`，不要自行改回 `WORKDIR /tmp` + 相对入口。
* 以 `node index.js` 启动时会自检交付物，缺首页会直接打印：`缺少文件 /app/index.html (cwd=/tmp)`，据此定位是哪个目录少文件；此时首页回 `500` 而不是假 `200`。自检只在 CLI 入口执行，把 `start()` 当库调用的宿主不会收到这行输出。

## 🧪 测试

```bash
npm test
```

覆盖点：文档与包契约、Docker 入口与 cwd 解耦、绝对路径启动、缺交付物时的诊断与 500、配置单一入口、日志开关、UUID 默认值、清理范围、架构地址映射与归一化、v0/v1 策略对象与匹配优先级、`start()` 返回形状与探针句柄、路由表；探针下载/赋权/启动闭环只在 POSIX 环境运行（Windows 下自动跳过）。

## 🧩 行为约定

* 配置只有一个解析入口 `resolveConfig()`，返回 `{ cfg, warnings }`；端口等非法值走 warnings，不抛异常、不污染配置对象。
* 日志只有一个开关：`SHOW_LOG=false` 时整个进程零输出，且不改写宿主进程的 `console`。
* 实例身份挂在探针描述对象上（`<pid>-<seq>`），同进程多次 `start()` 也不会撞名互删。
* 启动清理只删自身旧残留（带完整实例 id 的文件名，且早于 90 秒），同目录多实例互不影响。
* `start()` 每次调用创建独立实例，返回 `{ server, agent, cancel }`：
  * `agent` 是可等待的探针结果，四态可判别：`null`（未配置哪吒）、`{ status: 'failed' }`（下载/启动失败，仍带 `bin`/`args`）、`{ status: 'error', error }`（内部异常）、`{ status: 'running' }`（含 `bin` / `args` / `child` / `cleanupTimer`）。
  * `cancel()` 返回 `'now'`（已取消当前定时器）/ `'pending'`（agent 未就绪，已排队，就绪后立即兑现）/ `'none'`（无可取消）。
  * 端口与日志都在调用时解析，重复启动不会崩溃。
* 首页文件名只有 `ASSETS.page` 一处定义：路由 `/index.html`、`500` 文案、部署自检都从它派生。
* 部署自检（`缺少文件 … (cwd=…)`）只在 CLI 入口执行，把 `start()` 当库调用的宿主不会收到这类输出。
* v0 / v1 的差异封在策略对象里（含匹配规则与 `priority`），匹配顺序由数据决定、兜底项唯一；下载、启动、清理都以同一份描述对象为准。
* 导出面只有 `start` / `resolveConfig` / `handleRequest` / `buildAgent`（`__test` 仅供测试）。

## 📄 协议

MIT
