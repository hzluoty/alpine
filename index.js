#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 静态网页 + 哪吒探针接入（无隧道代理、无订阅、无节点生成）
// 分区: [配置] [日志] [工具] [探针] [网页服务] [启动]
// 导出面只有 start / resolveConfig / handleRequest / buildAgent + 测试专用 __test
// ---------------------------------------------------------------------------

const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ================================ 配置 ================================
// 内置固定 UUID: 仅作为单机默认值, 多机部署必须各自覆盖 UUID
const DEFAULT_UUID = '9afd1229-b893-40c1-84dd-51e7ce204913';
const DEFAULT_HTTP_PORT = 3000;
const STALE_AFTER_MS = 90000;   // 旧残留的判定阈值, 与 scheduleCleanup 的 90s 对齐

// 端口统一成 number, 非法值回落默认端口并给出 warning（不混进配置对象）
function normalizePort(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { port: fallback, warning: null };
  }
  const port = Number(String(raw).trim());
  if (Number.isInteger(port) && port >= 0 && port <= 65535) {
    return { port, warning: null };
  }
  return { port: fallback, warning: `PORT=${raw} 不是合法端口, 已回落到 ${fallback}` };
}

// 探针下载地址, 按架构显式映射, 不做字符串替换（resolveConfig 内部实现）
function archSources(arch, env) {
  if (arch === 'arm') {
    return [env.NEZHA_URL_ARM || 'https://arm64.oooen.com',
            env.NEZHA_URL_BACKUP_ARM || 'https://arm64.ssss.nyc.mn'];
  }
  return [env.NEZHA_URL || 'https://amd64.oooen.com',
          env.NEZHA_URL_BACKUP || 'https://amd64.ssss.nyc.mn'];
}

// 唯一的配置解析入口: 返回纯净配置 + 警告列表, 所有模块都消费这一个对象
function resolveConfig(env = process.env) {
  const httpPort = normalizePort(env.SERVER_PORT || env.PORT, DEFAULT_HTTP_PORT);
  const cfg = {
    filePath: env.FILE_PATH || '.npm',
    httpPort: httpPort.port,
    uuid: env.UUID || DEFAULT_UUID,
    showLog: !['false', 'disable', 'no'].includes(String(env.SHOW_LOG || 'true').toLowerCase()),
    nezha: {
      server: env.NEZHA_SERVER || '',
      port: env.NEZHA_PORT || '',
      key: env.NEZHA_KEY || ''
    },
    sources: {
      amd: archSources('amd', env),
      arm: archSources('arm', env)
    }
  };
  return { cfg, warnings: [httpPort.warning].filter(Boolean) };
}

// ================================ 日志 ================================
// 日志是每个实例自带的状态, 没有进程级开关, 也不改写全局 console
function createLogger(enabled = true) {
  return {
    log: (...args) => { if (enabled) console.log(...args); },
    err: (...args) => { if (enabled) console.error(...args); }
  };
}

// ================================ 工具 ================================
// 架构归一化: os.arch() 与外部传入的 arch 走同一条判定
function normalizeArch(arch) {
  return (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') ? 'arm' : 'amd';
}

function getSystemArchitecture() {
  return normalizeArch(os.arch());
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 流式下载, 跟随重定向
function fetchTo(url, destPath, redirects = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return resolve(fetchTo(new URL(res.headers.location, url).toString(), destPath, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const tmpPath = `${destPath}.download`;
      const writer = fs.createWriteStream(tmpPath);
      res.pipe(writer);

      writer.on('finish', () => {
        writer.close((closeError) => {
          if (closeError) {
            try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
            return reject(closeError);
          }
          try {
            fs.renameSync(tmpPath, destPath);
            resolve(destPath);
          } catch (renameError) {
            try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
            reject(renameError);
          }
        });
      });
      writer.on('error', (error) => {
        try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
        reject(error);
      });
    });

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// ================================ 探针 ================================
const TLS_PORTS = new Set(['443', '8443', '2096', '2087', '2083', '2053']);

function tlsEnabled(port) {
  return TLS_PORTS.has(String(port || '').trim());
}

// v1 的 config.yaml
function buildConfigYaml(server, key, uuid, useTls) {
  return `
client_secret: ${key}
debug: false
disable_auto_update: true
disable_command_execute: false
disable_force_update: true
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: true
ip_report_period: 1800
report_delay: 4
server: ${server}
skip_connection_count: true
skip_procs_count: true
temperature: false
tls: ${useTls ? 'true' : 'false'}
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: ${uuid}`;
}

// 实例 id 格式只有一处定义: 生产者按它自检, 清理规则也从它派生
const INSTANCE_ID_RE = /^\d+-\d+$/;                              // <pid>-<seq>
const INSTANCE_ID_PATTERN = INSTANCE_ID_RE.source.slice(1, -1);   // 去掉锚点, 供嵌入正则
let instanceSeq = 0;

function nextInstanceId() {
  instanceSeq += 1;
  const id = `${process.pid}-${instanceSeq}`;
  if (!INSTANCE_ID_RE.test(id)) throw new Error(`实例 id 与清理规则不一致: ${id}`);
  return id;
}

// v0 / v1 的差异全部封在策略对象里: 文件名、TLS 判定、参数、落盘、清理
// 统一接口: setup(agent, cfg) 把参数算进 agent.args; prepare(agent); cleanupTargets(agent)
const VARIANTS = {
  v0: {
    kind: 'v0',
    priority: 10,                                // 优先级即匹配顺序, 数字大的先试
    matches: (cfg) => Boolean(cfg.nezha.port),   // 有哪吒端口 = v0
    remoteName: 'agent',        // 远端文件名
    binName: 'nezha-agent',     // 本地文件名前缀
    configPrefix: null,
    setup(agent, cfg) {
      agent.tls = tlsEnabled(cfg.nezha.port);
      agent.args = [
        '-s', `${cfg.nezha.server}:${cfg.nezha.port}`,
        '-p', cfg.nezha.key,
        ...(agent.tls ? ['--tls'] : []),
        '--disable-auto-update', '--report-delay', '4', '--skip-conn', '--skip-procs'
      ];
    },
    prepare() { /* v0 无需落盘 */ },
    cleanupTargets: (agent) => [agent.bin]
  },
  v1: {
    kind: 'v1',
    priority: 0,                                 // 兜底项, 优先级最低
    matches: () => true,
    remoteName: 'v1',
    binName: 'nezha-v1',
    configPrefix: 'nezha-config',
    setup(agent, cfg) {
      const server = cfg.nezha.server;
      agent.tls = tlsEnabled(server.includes(':') ? server.split(':').pop() : '');
      // 表字段是文件名的唯一所有者, setup 不再另持一个常量
      agent.configPath = path.join(cfg.filePath, `${agent.variant.configPrefix}-${agent.id}.yaml`);
      agent.configYaml = buildConfigYaml(server, cfg.nezha.key, cfg.uuid, agent.tls);
      agent.args = ['-c', agent.configPath];
    },
    prepare(agent) { fs.writeFileSync(agent.configPath, agent.configYaml); },
    cleanupTargets: (agent) => [agent.bin, agent.configPath]
  }
};

Object.values(VARIANTS).forEach(variant => Object.freeze(variant));
Object.freeze(VARIANTS);

// 匹配顺序由 priority 数据决定, 不靠对象字面量书写位置
const VARIANT_ORDER = Object.values(VARIANTS).slice().sort((a, b) => b.priority - a.priority);

// 自有文件规则从策略表派生: 前缀 + 必选的实例 id + 可选的 .download 临时后缀
const OWNED_PATTERNS = [];
Object.values(VARIANTS).forEach(variant => {
  OWNED_PATTERNS.push(new RegExp(`^${variant.binName}-${INSTANCE_ID_PATTERN}(\\.download)?$`));
  if (variant.configPrefix) {
    OWNED_PATTERNS.push(new RegExp(`^${variant.configPrefix}-${INSTANCE_ID_PATTERN}\\.yaml$`));
  }
});

function isOwnedFile(name) {
  return OWNED_PATTERNS.some(pattern => pattern.test(name));
}

// 只清自己的旧残留: 只认自有文件名, 且只删 90s 前创建的文件
function cleanupOldFiles(filePath, now = Date.now()) {
  try {
    if (!fs.existsSync(filePath)) return;
    fs.readdirSync(filePath).forEach(file => {
      if (!isOwnedFile(file)) return;
      const target = path.join(filePath, file);
      try {
        const stat = fs.statSync(target);
        if (!stat.isFile()) return;
        if (now - stat.mtimeMs < STALE_AFTER_MS) return; // 可能是同目录另一实例正在用
        fs.unlinkSync(target);
      } catch (error) {
        // 忽略所有错误，不记录日志
      }
    });
  } catch (error) {
    // 忽略所有错误，不记录日志
  }
}

// 一次性构造探针描述对象, 下载/赋权/启动/清理都只吃它
// buildAgent 只负责“按策略表的 matches 选 variant”，不再自带版本分支
function buildAgent(cfg, arch = getSystemArchitecture()) {
  const { server, key } = cfg.nezha;
  if (!server || !key) return null;

  // 适用性由策略表自述, 优先级由 priority 决定
  const variant = VARIANT_ORDER.find(candidate => candidate.matches(cfg));
  if (!variant) return null;

  const agent = {
    id: nextInstanceId(),
    variant,
    kind: variant.kind,
    urls: cfg.sources[normalizeArch(arch)].map(source => `${source}/${variant.remoteName}`)
  };
  agent.bin = path.join(cfg.filePath, `${variant.binName}-${agent.id}`);
  variant.setup(agent, cfg);
  return agent;
}

// 下载探针 (主源 -> 备用源), 成功返回 true
async function downloadAgent(agent, logger) {
  for (const url of agent.urls) {
    try {
      await fetchTo(url, agent.bin);
      logger.log(`Download ${path.basename(agent.bin)} successfully`);
      try {
        fs.chmodSync(agent.bin, 0o775);
        logger.log(`Empowerment success for ${agent.bin}: 775`);
      } catch (error) {
        logger.err(`Empowerment failed for ${agent.bin}: ${error}`);
      }
      return true;
    } catch (error) {
      logger.err(`Download ${path.basename(agent.bin)} failed: ${error.message}`);
      logger.log(`Retrying ${path.basename(agent.bin)} from backup source`);
    }
  }
  logger.err('Error downloading nezha agent');
  return false;
}

// 启动探针 (detached, 无 shell 拼串, 密钥不会被 shell 解释)
function runAgent(agent, logger) {
  agent.variant.prepare(agent);
  const child = spawn(agent.bin, agent.args, { detached: true, stdio: 'ignore' });
  child.on('error', (error) => logger.err(`${path.basename(agent.bin)} start failed: ${error.message}`));
  child.unref();
  logger.log(`${path.basename(agent.bin)} is running (nezha ${agent.kind})`);
  return child;
}

// 90s后删除探针文件, 释放空间; 返回 timer, 供调用方取消
function scheduleCleanup(agent, logger, delay = STALE_AFTER_MS) {
  const timer = setTimeout(() => {
    agent.variant.cleanupTargets(agent).forEach(target => {
      try { fs.unlinkSync(target); } catch (error) { /* ignore */ }
    });
    logger.log('App is running');
  }, delay);
  timer.unref();
  return timer;
}

async function startAgent(cfg, logger) {
  const agent = buildAgent(cfg);
  if (!agent) {
    logger.log('NEZHA variable is empty, skip running nezha agent');
    return null;
  }
  if (!await downloadAgent(agent, logger)) {
    agent.status = 'failed';
    return agent;
  }
  agent.child = runAgent(agent, logger);
  agent.cleanupTimer = scheduleCleanup(agent, logger);
  agent.status = 'running';
  return agent;
}

// ============================== 网页服务 ==============================
// 交付物名单只在这里定义: 路由、500 文案、自检、测试都指向它
const ASSETS = Object.freeze({ page: 'index.html' });
const INDEX_PATH = path.join(__dirname, ASSETS.page);

// 部署自检: 只报真正可能漏拷的首页, 纯报告（由 500 降级兑底）
function reportMissingAssets(logger) {
  const target = path.join(__dirname, ASSETS.page);
  if (!fs.existsSync(target)) {
    logger.err(`缺少文件 ${target} (cwd=${process.cwd()})`);
  }
}

function serveIndex(req, res) {
  fs.readFile(INDEX_PATH, (error, data) => {
    if (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${ASSETS.page} missing`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function serveHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ok');
}

function notFound(req, res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

const ROUTES = {
  '/': serveIndex,
  [`/${ASSETS.page}`]: serveIndex,
  '/health': serveHealth,
  '/healthz': serveHealth
};

function handleRequest(req, res) {
  const urlPath = (req.url || '/').split('?')[0];
  (ROUTES[urlPath] || notFound)(req, res);
}

// ================================ 启动 ================================
// 配置与 logger 只造一次: CLI 与库入口共用 prepare
function prepare(env) {
  const { cfg, warnings } = resolveConfig(env);
  const logger = createLogger(cfg.showLog);
  warnings.forEach(warning => logger.err(warning));
  return { cfg, logger };
}

// 每次调用都创建独立实例: 端口与日志都在调用时解析, 不冻结在 import 期
function start(env = process.env) {
  const { cfg, logger } = prepare(env);
  return launch(cfg, logger);
}

function launch(cfg, logger) {
  ensureDir(cfg.filePath);
  cleanupOldFiles(cfg.filePath);

  const server = http.createServer(handleRequest);
  server.on('error', (error) => logger.err(`http server error: ${error.message}`));
  server.listen(cfg.httpPort, () => logger.log(`http server is running on ${server.address().port}!`));

  // 探针生命周期交给调用方: agent 可等待/查询, cancel 可提前取消 90s 清理
  // agent 结果三态: null(未配置) / { status:'failed' } / { status:'running' }
  const state = { agent: null, settled: false, cancelRequested: false };
  const agent = startAgent(cfg, logger)
    .then(result => {
      state.agent = result;
      // 提前调用过 cancel: agent 就绪后立即兑现, 不给 90s 清理留下窗口
      if (state.cancelRequested && result && result.cleanupTimer) {
        clearTimeout(result.cleanupTimer);
        result.cleanupTimer = null;
      }
      return result;
    })
    .catch(error => {
      logger.err(`nezha agent error: ${error.message}`);
      return { status: 'error', error };
    })
    .finally(() => { state.settled = true; });

  // 返回值可判别: 'now' 已取消 / 'pending' 已排队(agent 未就绪) / 'none' 无可取消
  const cancel = () => {
    if (!state.settled) {
      state.cancelRequested = true;
      return 'pending';
    }
    if (!state.agent || !state.agent.cleanupTimer) return 'none';
    clearTimeout(state.agent.cleanupTimer);
    state.agent.cleanupTimer = null;
    return 'now';
  };

  return { server, agent, cancel };
}

// CLI 入口: 部署自检只在这里做, 不污染把 start() 当库调用的宿主
function main(env = process.env) {
  const { cfg, logger } = prepare(env);
  reportMissingAssets(logger);
  return launch(cfg, logger);
}

if (require.main === module) {
  main();
}

module.exports = {
  start,
  resolveConfig,
  handleRequest,
  buildAgent,
  // 仅测试使用
  __test: {
    ASSETS,
    reportMissingAssets,
    createLogger,
    cleanupOldFiles,
    isOwnedFile,
    buildConfigYaml,
    tlsEnabled,
    startAgent,
    normalizePort,
    normalizeArch,
    nextInstanceId,
    INSTANCE_ID_RE,
    INSTANCE_ID_PATTERN,
    VARIANT_ORDER,
    VARIANTS,
    ROUTES
  }
};
