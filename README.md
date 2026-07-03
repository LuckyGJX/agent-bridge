# Zhipin Claw Agent Bridge

Agent Bridge 是智聘 Claw 的本地客户端。它通过 WebSocket 连接平台，把平台收到的 OpenAI 兼容请求安全地转发到用户本机的私有 Agent 后端，例如 OpenClaw 或 QwenPaw。

它适合这些场景：

- 本地运行 Agent，不暴露真实后端地址和实现逻辑。
- 平台只做认证、计费、路由和隐私控制。
- 用户用一个本地客户端承载多个 AgentID。
- 外部调用方继续使用 OpenAI 兼容的 `/v1/chat/completions`。

## 工作方式

```text
OpenAI client
  -> Zhipin Claw /v1/chat/completions
  -> WebSocket tunnel
  -> Agent Bridge on user's machine
  -> local OpenClaw or QwenPaw backend
```

平台发给客户端的隧道消息：

```json
{
  "type": "invoke",
  "requestId": "req-id",
  "agentId": "agent_xxx",
  "stream": false,
  "body": {
    "model": "agent_xxx",
    "messages": [{ "role": "user", "content": "hello" }],
    "session_id": "optional-session"
  }
}
```

客户端返回：

- 非流式：`result`
- 流式：`chunk` + `done`
- 失败：`error`

## 支持的本地后端

### OpenClaw

OpenClaw 需要启用 OpenAI 兼容 HTTP 入口：

```text
gateway.http.endpoints.chatCompletions.enabled=true
```

Agent Bridge 会请求：

```text
POST http://127.0.0.1:18789/v1/chat/completions
Authorization: Bearer <OPENCLAW_TOKEN>
```

远程 AgentID 会通过映射转换成本地模型，例如：

```text
agent_e725f0eefcb6e85c -> openclaw/meishi
```

### QwenPaw

QwenPaw 使用控制台接口：

```text
POST http://127.0.0.1:8088/api/console/chat
X-Agent-Id: <localAgentId>
```

OpenAI `messages` 会被转换成 QwenPaw 的 `input` 格式，`session_id` 会透传。

## 安装开发版

```bash
npm install
cp .env.example .env
npm run dev
```

本地配置界面：

```text
http://127.0.0.1:9876
```

编译后运行：

```bash
npm run build
npm start
```

## 配置

常用环境变量：

```env
CLOUD_WS_URL=ws://localhost:3000/node-tunnel?userId=<user-id>
CLOUD_AUTH_TOKEN=<node-token>

OPENCLAW_ENABLED=true
OPENCLAW_BASE_URL=http://127.0.0.1:18789
OPENCLAW_TOKEN=<openclaw-token>
OPENCLAW_AGENT_ID=main

QWENPAW_ENABLED=false
QWENPAW_BASE_URL=http://127.0.0.1:8088
QWENPAW_TOKEN=
QWENPAW_AGENT_ID=default

BRIDGE_MAPPINGS=agent_xxx:meishi:openclaw,agent_yyy:default:qwenpaw
BRIDGE_PORT=9876
LOG_LEVEL=info
```

优先级：

1. 本地配置文件 `.bridge-config.json`
2. 已设置的环境变量覆盖对应字段
3. 默认值

桌面版会把配置保存到系统应用数据目录，不会写入 app 包内部。

## 桌面版打包

macOS DMG：

```bash
npm run package:mac
```

生成文件在：

```text
release/
```

如果需要 Windows 或 Linux 包，可以使用：

```bash
npm run package:win
npm run package:linux
```

## 平台侧连接模型

当前平台按 `userId` 维护一个活跃 WebSocket 连接。一个本地 Agent Bridge 可以承载多个 AgentID，适合一台机器上跑多个 Agent。

注意：

- 同一个用户可以有多个 nodeToken 用于认证。
- 但同一用户如果多台客户端同时连接，后连接的客户端会挤掉前一个连接。
- 如果要支持同一用户多台机器同时在线，平台需要改成按 `nodeId/nodeToken` 保存连接，并按 `agentId -> node` 路由。

## 安全注意

- 不要提交 `.env` 或 `.bridge-config.json`。
- 不要把 OpenClaw/QwenPaw token 写进 README、测试脚本或 Issue。
- 平台 API Key 只用于平台入口；本地后端 token 只保存在本机客户端。
- OpenClaw 的 `x-openclaw-model` header 不要用于平台远程 AgentID，否则可能触发模型权限校验失败。

## 常见问题

### 平台请求超时

检查本地客户端是否显示 `registered`，并确认平台日志出现 `invoke sent` 后是否有 `result received`。

### OpenClaw 返回 401 Unauthorized

检查 `OPENCLAW_TOKEN` 是否正确，并确认 OpenClaw 已启用：

```text
gateway.http.endpoints.chatCompletions.enabled=true
```

### OpenClaw 返回“无该模型使用权限”

检查远程 AgentID 是否正确映射到本地模型，例如：

```text
agent_xxx:meishi:openclaw
```

客户端最终发送给 OpenClaw 的模型会是：

```text
openclaw/meishi
```
