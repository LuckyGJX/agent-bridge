import http from 'http';
import { BridgeConfig, BridgeState } from './types';
import { Logger } from './logger';

export class WebServer {
  private server: http.Server | null = null;
  private config: BridgeConfig;
  private logger: Logger;
  private getState: () => BridgeState;
  private onConfigUpdate: (config: Partial<BridgeConfig>) => void;
  private onRestart: () => void;

  constructor(
    config: BridgeConfig,
    getState: () => BridgeState,
    onConfigUpdate: (config: Partial<BridgeConfig>) => void,
    onRestart: () => void,
  ) {
    this.config = config;
    this.logger = new Logger(config);
    this.getState = getState;
    this.onConfigUpdate = onConfigUpdate;
    this.onRestart = onRestart;
  }

  start(): void {
    const port = this.config.bridge.port;
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
    this.server.listen(port, () => {
      this.logger.info(`Web config UI running at http://127.0.0.1:${port}`);
    });
  }

  stop(): void {
    if (this.server) { this.server.close(); this.server = null; }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url || '/', `http://127.0.0.1:${this.config.bridge.port}`);
    try {
      switch (url.pathname) {
        case '/': this.serveIndex(res); break;
        case '/api/status': this.serveStatus(res); break;
        case '/api/config':
          if (req.method === 'GET') this.serveConfig(res);
          else if (req.method === 'POST') this.handleConfigUpdate(req, res);
          break;
        case '/api/restart': this.handleRestart(res); break;
        default: res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      this.logger.error('Web server error:', err);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  private serveStatus(res: http.ServerResponse): void {
    const state = this.getState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
  }

  private serveConfig(res: http.ServerResponse): void {
    const mask = (s: string) => s ? `${s.slice(0, 4)}****` : '';
    const safeConfig = {
      cloud: { wsUrl: this.config.cloud.wsUrl, token: mask(this.config.cloud.token) },
      openclaw: { ...this.config.openclaw, token: mask(this.config.openclaw.token) },
      qwenpaw: { ...this.config.qwenpaw, token: mask(this.config.qwenpaw.token) },
      agentMappings: this.config.agentMappings,
      bridge: { ...this.config.bridge },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safeConfig));
  }

  private async handleConfigUpdate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    try {
      const updates = JSON.parse(body);
      this.onConfigUpdate(updates);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
  }

  private handleRestart(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Restarting...' }));
    setTimeout(() => this.onRestart(), 100);
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  private serveIndex(res: http.ServerResponse): void {
    const html = this.buildIndexHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private buildIndexHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Bridge - 配置</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0f0f0f; color: #e0e0e0; min-height: 100vh; padding: 24px;
    }
    .container { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 24px; font-weight: 600; margin-bottom: 4px; color: #fff; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }

    .status-bar {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 18px; border-radius: 10px; margin-bottom: 24px;
      background: #1a1a1a; border: 1px solid #2a2a2a;
    }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; background: #666; }
    .status-dot.connected { background: #4ade80; }
    .status-dot.connecting { background: #facc15; animation: pulse 1.5s ease-in-out infinite; }
    .status-dot.error { background: #f87171; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    .status-text { font-size: 14px; font-weight: 500; }
    .status-info { font-size: 12px; color: #888; margin-left: auto; }

    .split-row { display: flex; gap: 16px; margin-bottom: 16px; }
    .split-row .card { flex: 1; min-width: 0; }

    .card {
      background: #1a1a1a; border: 1px solid #2a2a2a;
      border-radius: 10px; padding: 20px; margin-bottom: 16px;
    }
    .card-title { font-size: 14px; font-weight: 600; color: #aaa; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.5px; }
    .card-title .badge {
      font-size: 11px; padding: 2px 8px; border-radius: 4px; margin-left: 6px;
      font-weight: 500; text-transform: none;
    }
    .badge-openclaw { background: #312e81; color: #a5b4fc; }
    .badge-qwenpaw { background: #14532d; color: #86efac; }

    .form-group { margin-bottom: 12px; }
    .form-group:last-child { margin-bottom: 0; }
    label { display: block; font-size: 13px; color: #999; margin-bottom: 5px; font-weight: 500; }
    input {
      width: 100%; padding: 9px 12px; border-radius: 8px;
      border: 1px solid #333; background: #111; color: #e0e0e0;
      font-size: 13px; font-family: 'SF Mono','Monaco','Inconsolata','Fira Code',monospace;
      outline: none; transition: border-color 0.2s;
    }
    input:focus { border-color: #6366f1; }
    input[type="password"] { letter-spacing: 2px; }
    input[type="checkbox"] { width: auto; accent-color: #6366f1; }
    .checkbox-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .checkbox-row label { margin-bottom: 0; }

    .btn-row { display: flex; gap: 10px; margin-top: 16px; }
    .btn {
      padding: 10px 20px; border-radius: 8px; border: none;
      font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s;
    }
    .btn-primary { background: #6366f1; color: #fff; }
    .btn-primary:hover { background: #5558e6; }
    .btn-secondary { background: #2a2a2a; color: #ccc; }
    .btn-secondary:hover { background: #333; }

    .mapping-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .mapping-table th { text-align: left; color: #888; font-weight: 500; padding: 8px 10px; border-bottom: 1px solid #2a2a2a; }
    .mapping-table td { padding: 8px 10px; border-bottom: 1px solid #1f1f1f; }
    .mapping-table input { width: 100%; padding: 6px 8px; font-size: 12px; }
    .mapping-table select { width: 100%; padding: 6px 8px; font-size: 12px; border-radius: 6px; border: 1px solid #333; background: #111; color: #e0e0e0; }
    .btn-sm {
      padding: 4px 10px; border-radius: 6px; border: none;
      font-size: 12px; cursor: pointer; transition: all 0.2s;
    }
    .btn-add { background: #166534; color: #4ade80; }
    .btn-add:hover { background: #14532d; }
    .btn-del { background: #7f1d1d; color: #fca5a5; }
    .btn-del:hover { background: #991b1b; }

    .toast {
      position: fixed; bottom: 24px; right: 24px;
      padding: 12px 20px; border-radius: 8px; font-size: 14px;
      animation: slideIn 0.3s ease-out; z-index: 100; max-width: 360px;
    }
    .toast.success { background: #166534; color: #4ade80; }
    .toast.error { background: #7f1d1d; color: #f87171; }
    @keyframes slideIn { from { transform: translateY(20px); opacity:0 } to { transform: translateY(0); opacity:1 } }

    .section-title { font-size: 16px; font-weight: 600; color: #fff; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔗 Agent Bridge</h1>
    <p class="subtitle">本地 Agent 云桥接器 · OpenClaw / QwenPaw</p>

    <div class="status-bar">
      <div class="status-dot" id="statusDot"></div>
      <span class="status-text" id="statusText">加载中...</span>
      <span class="status-info" id="statusInfo"></span>
    </div>

    <!-- 云端连接 -->
    <div class="card">
      <div class="card-title">☁️ 云端连接</div>
      <div class="form-group">
        <label>WebSocket 地址</label>
        <input type="text" id="wsUrl" placeholder="wss://your-cloud-gateway.com/ws">
      </div>
      <div class="form-group">
        <label>认证 Token</label>
        <input type="password" id="cloudToken" placeholder="输入云端认证 token">
      </div>
    </div>

    <!-- 两个后端并排 -->
    <div class="split-row">
      <!-- OpenClaw -->
      <div class="card">
        <div class="card-title">🏠 OpenClaw <span class="badge badge-openclaw">OpenAI Compatible</span></div>
        <div class="checkbox-row">
          <input type="checkbox" id="ocEnabled" onchange="toggleBackend('openclaw')">
          <label>启用</label>
        </div>
        <div class="form-group">
          <label>API 地址</label>
          <input type="text" id="ocUrl" placeholder="http://127.0.0.1:18789">
        </div>
        <div class="form-group">
          <label>认证 Token</label>
          <input type="password" id="ocToken" placeholder="输入 OpenClaw token">
        </div>
        <div class="form-group">
          <label>默认 Agent ID</label>
          <input type="text" id="ocAgentId" placeholder="main">
        </div>
      </div>

      <!-- QwenPaw -->
      <div class="card">
        <div class="card-title">🐾 QwenPaw <span class="badge badge-qwenpaw">POST /api/console/chat</span></div>
        <div class="checkbox-row">
          <input type="checkbox" id="qpEnabled" onchange="toggleBackend('qwenpaw')">
          <label>启用</label>
        </div>
        <div class="form-group">
          <label>API 地址</label>
          <input type="text" id="qpUrl" placeholder="http://127.0.0.1:8088">
        </div>
        <div class="form-group">
          <label>认证 Token（远程访问时必需）</label>
          <input type="password" id="qpToken" placeholder="输入 QwenPaw token">
        </div>
        <div class="form-group">
          <label>X-Agent-Id</label>
          <input type="text" id="qpAgentId" placeholder="default">
        </div>
      </div>
    </div>

    <!-- Agent 映射表 -->
    <div class="card">
      <div class="card-title">🔀 Agent ID 映射</div>
      <p style="font-size:12px;color:#666;margin-bottom:12px;">
        远程传来的 agentId（OpenAI model 字段）→ 本地实际 agentId + 后端路由
      </p>
      <table class="mapping-table">
        <thead>
          <tr>
            <th style="width:30%">远程 Agent ID</th>
            <th style="width:30%">本地 Agent ID</th>
            <th style="width:25%">后端</th>
            <th style="width:15%"></th>
          </tr>
        </thead>
        <tbody id="mappingBody"></tbody>
      </table>
      <button class="btn btn-add btn-sm" style="margin-top:10px;" onclick="addMapping()">+ 添加映射</button>
    </div>

    <div class="btn-row">
      <button class="btn btn-primary" onclick="saveConfig()">💾 保存配置</button>
      <button class="btn btn-secondary" onclick="restartBridge()">🔄 重启桥接</button>
    </div>
  </div>
  <div id="toastContainer"></div>

  <script>
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const statusInfo = document.getElementById('statusInfo');

    async function loadConfig() {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      // 云端
      document.getElementById('wsUrl').value = cfg.cloud.wsUrl || '';
      document.getElementById('cloudToken').value = cfg.cloud.token || '';
      // OpenClaw
      document.getElementById('ocEnabled').checked = cfg.openclaw.enabled;
      document.getElementById('ocUrl').value = cfg.openclaw.baseUrl || '';
      document.getElementById('ocToken').value = cfg.openclaw.token || '';
      document.getElementById('ocAgentId').value = cfg.openclaw.defaultAgentId || 'main';
      // QwenPaw
      document.getElementById('qpEnabled').checked = cfg.qwenpaw.enabled;
      document.getElementById('qpUrl').value = cfg.qwenpaw.baseUrl || '';
      document.getElementById('qpToken').value = cfg.qwenpaw.token || '';
      document.getElementById('qpAgentId').value = cfg.qwenpaw.defaultAgentId || 'main';
      // 映射
      renderMappings(cfg.agentMappings || []);
    }

    let mappings = [];

    function renderMappings(list) {
      mappings = list || [];
      const tbody = document.getElementById('mappingBody');
      tbody.innerHTML = mappings.map((m, i) => \`
        <tr>
          <td><input type="text" value="\${esc(m.remoteAgentId)}" placeholder="remote-agent-id" onchange="updateMapping(\${i},'remoteAgentId',this.value)"></td>
          <td><input type="text" value="\${esc(m.localAgentId)}" placeholder="local-agent-id" onchange="updateMapping(\${i},'localAgentId',this.value)"></td>
          <td>
            <select onchange="updateMapping(\${i},'backend',this.value)">
              <option value="openclaw"\${m.backend==='openclaw'?' selected':''}>OpenClaw</option>
              <option value="qwenpaw"\${m.backend==='qwenpaw'?' selected':''}>QwenPaw</option>
            </select>
          </td>
          <td><button class="btn btn-del btn-sm" onclick="removeMapping(\${i})">✕</button></td>
        </tr>
      \`).join('');
    }

    function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function addMapping() {
      mappings.push({ remoteAgentId: '', localAgentId: '', backend: 'openclaw' });
      renderMappings(mappings);
    }

    function removeMapping(i) {
      mappings.splice(i, 1);
      renderMappings(mappings);
    }

    function updateMapping(i, key, value) {
      mappings[i][key] = value;
    }

    function toggleBackend() {}

    async function loadStatus() {
      try {
        const res = await fetch('/api/status');
        const state = await res.json();
        updateStatusUI(state);
      } catch (e) {
        updateStatusUI({ status: 'error' });
      }
    }

    function updateStatusUI(state) {
      statusDot.className = 'status-dot';
      switch (state.status) {
        case 'connected': case 'registered':
          statusDot.classList.add('connected');
          statusText.textContent = state.status === 'registered' ? '已注册' : '已连接';
          break;
        case 'connecting':
          statusDot.classList.add('connecting');
          statusText.textContent = '连接中...';
          break;
        case 'error':
          statusDot.classList.add('error');
          statusText.textContent = '错误';
          break;
        default:
          statusText.textContent = '未连接';
      }
      const info = [];
      if (state.bridgeId) info.push('ID: ' + state.bridgeId);
      if (state.messagesReceived) info.push('收: ' + state.messagesReceived);
      if (state.messagesSent) info.push('发: ' + state.messagesSent);
      statusInfo.textContent = info.join(' · ');
    }

    async function saveConfig() {
      const body = {
        cloud: {
          wsUrl: document.getElementById('wsUrl').value,
          token: document.getElementById('cloudToken').value,
        },
        openclaw: {
          baseUrl: document.getElementById('ocUrl').value,
          token: document.getElementById('ocToken').value,
          defaultAgentId: document.getElementById('ocAgentId').value,
          modelPrefix: 'openclaw/',
          enabled: document.getElementById('ocEnabled').checked,
        },
        qwenpaw: {
          baseUrl: document.getElementById('qpUrl').value,
          token: document.getElementById('qpToken').value,
          defaultAgentId: document.getElementById('qpAgentId').value,
          modelPrefix: '',
          enabled: document.getElementById('qpEnabled').checked,
        },
        agentMappings: mappings.filter(m => m.remoteAgentId && m.localAgentId),
        bridge: {
          defaultBackend: document.getElementById('ocEnabled').checked ? 'openclaw' : 'qwenpaw',
        },
      };
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        showToast(data.success ? 'success' : 'error', data.success ? '配置已保存 · 请重启生效' : '保存失败');
      } catch (e) {
        showToast('error', '保存失败: ' + e.message);
      }
    }

    async function restartBridge() {
      try {
        await fetch('/api/restart');
        showToast('success', '正在重启...');
        setTimeout(loadStatus, 2000);
      } catch (e) {
        showToast('error', '重启失败');
      }
    }

    function showToast(type, message) {
      const el = document.createElement('div');
      el.className = 'toast ' + type;
      el.textContent = message;
      document.getElementById('toastContainer').appendChild(el);
      setTimeout(() => el.remove(), 3000);
    }

    loadConfig();
    loadStatus();
    setInterval(loadStatus, 5000);
  </script>
</body>
</html>`;
  }
}