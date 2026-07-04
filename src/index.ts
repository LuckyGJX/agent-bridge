import { loadConfig } from './config';
import { AgentBridge } from './bridge';
import { WebServer } from './web-server';
import { Logger } from './logger';
import { BridgeConfig } from './types';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

import dotenv from 'dotenv';
dotenv.config({ path: process.env.BRIDGE_ENV_FILE || undefined });

const CONFIG_FILE =
  process.env.BRIDGE_CONFIG_FILE || join(__dirname, '..', '.bridge-config.json');

let bridge: AgentBridge | null = null;
let webServer: WebServer | null = null;
let currentConfig: BridgeConfig;

function hasEnv(name: string): boolean {
  return typeof process.env[name] === 'string' && process.env[name] !== '';
}

function secretValue(current: string, incoming?: string): string {
  if (incoming === undefined) return current;
  if (!incoming || incoming.endsWith('****')) return current;
  return incoming;
}

function mergeSavedWithEnv(saved: BridgeConfig): BridgeConfig {
  const envConfig = loadConfig();
  const next: BridgeConfig = {
    ...saved,
    cloud: {
      wsUrl: hasEnv('CLOUD_WS_URL') ? envConfig.cloud.wsUrl : saved.cloud.wsUrl,
      token: hasEnv('CLOUD_AUTH_TOKEN') ? envConfig.cloud.token : saved.cloud.token,
    },
    openclaw: {
      ...saved.openclaw,
      baseUrl: hasEnv('OPENCLAW_BASE_URL') ? envConfig.openclaw.baseUrl : saved.openclaw.baseUrl,
      token: hasEnv('OPENCLAW_TOKEN') ? envConfig.openclaw.token : saved.openclaw.token,
      defaultAgentId: hasEnv('OPENCLAW_AGENT_ID') ? envConfig.openclaw.defaultAgentId : saved.openclaw.defaultAgentId,
      enabled: hasEnv('OPENCLAW_ENABLED') ? envConfig.openclaw.enabled : saved.openclaw.enabled,
    },
    qwenpaw: {
      ...saved.qwenpaw,
      baseUrl: hasEnv('QWENPAW_BASE_URL') ? envConfig.qwenpaw.baseUrl : saved.qwenpaw.baseUrl,
      token: hasEnv('QWENPAW_TOKEN') ? envConfig.qwenpaw.token : saved.qwenpaw.token,
      defaultAgentId: hasEnv('QWENPAW_AGENT_ID') ? envConfig.qwenpaw.defaultAgentId : saved.qwenpaw.defaultAgentId,
      enabled: hasEnv('QWENPAW_ENABLED') ? envConfig.qwenpaw.enabled : saved.qwenpaw.enabled,
    },
    agentMappings: hasEnv('BRIDGE_MAPPINGS') ? envConfig.agentMappings : saved.agentMappings,
    bridge: {
      ...saved.bridge,
      agentId: hasEnv('BRIDGE_AGENT_ID') ? envConfig.bridge.agentId : saved.bridge.agentId,
      defaultBackend: hasEnv('DEFAULT_BACKEND') ? envConfig.bridge.defaultBackend : saved.bridge.defaultBackend,
      port: hasEnv('BRIDGE_PORT') ? envConfig.bridge.port : saved.bridge.port,
      autoReconnect: hasEnv('AUTO_RECONNECT') ? envConfig.bridge.autoReconnect : saved.bridge.autoReconnect,
      reconnectIntervalMs: hasEnv('RECONNECT_INTERVAL') ? envConfig.bridge.reconnectIntervalMs : saved.bridge.reconnectIntervalMs,
      maxReconnectAttempts: hasEnv('MAX_RECONNECT_ATTEMPTS') ? envConfig.bridge.maxReconnectAttempts : saved.bridge.maxReconnectAttempts,
      heartbeatIntervalMs: hasEnv('HEARTBEAT_INTERVAL') ? envConfig.bridge.heartbeatIntervalMs : saved.bridge.heartbeatIntervalMs,
      logLevel: hasEnv('LOG_LEVEL') ? envConfig.bridge.logLevel : saved.bridge.logLevel,
    },
  };
  return next;
}

/** 加载配置：优先持久化配置；已设置的环境变量会覆盖对应字段。 */
function loadPersistedConfig(): BridgeConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, 'utf-8');
      const saved = JSON.parse(raw) as BridgeConfig;
      return mergeSavedWithEnv(saved);
    }
  } catch (e) { /* fall through */ }
  return loadConfig();
}

/** 保存配置到 JSON 文件 */
function persistConfig(config: BridgeConfig): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    // 静默失败
  }
}

function createBridge(config: BridgeConfig): AgentBridge {
  return new AgentBridge(config);
}

function startServer(config: BridgeConfig): void {
  webServer = new WebServer(
    config,
    () => bridge?.getState() || {
      status: 'disconnected', connectedAt: null, lastHeartbeat: null,
      reconnectAttempts: 0, messagesReceived: 0, messagesSent: 0,
      errors: [], bridgeId: null, cloudBridgeId: null,
    },
    (updates) => {
      // 合并 Web UI 的更新到当前配置
      mergeConfig(updates);
      const logger = new Logger(currentConfig);
      logger.info('Config updated via Web UI, restarting...');
      persistConfig(currentConfig);
      restart();
    },
    () => restart(),
  );
  webServer.start();
}

/** 将 Web UI 的更新合并到 currentConfig */
function mergeConfig(updates: Partial<BridgeConfig> & {
  cloud?: Partial<BridgeConfig['cloud']>;
  openclaw?: Partial<BridgeConfig['openclaw']>;
  qwenpaw?: Partial<BridgeConfig['qwenpaw']>;
  agentMappings?: BridgeConfig['agentMappings'];
  bridge?: Partial<BridgeConfig['bridge']>;
}): void {
  if (updates.cloud) {
    currentConfig.cloud = {
      ...currentConfig.cloud,
      ...updates.cloud,
      token: secretValue(currentConfig.cloud.token, updates.cloud.token),
    };
  }
  if (updates.openclaw) {
    currentConfig.openclaw = {
      ...currentConfig.openclaw,
      ...updates.openclaw,
      token: secretValue(currentConfig.openclaw.token, updates.openclaw.token),
    };
  }
  if (updates.qwenpaw) {
    currentConfig.qwenpaw = {
      ...currentConfig.qwenpaw,
      ...updates.qwenpaw,
      token: secretValue(currentConfig.qwenpaw.token, updates.qwenpaw.token),
    };
  }
  if (updates.agentMappings !== undefined) {
    currentConfig.agentMappings = updates.agentMappings;
  }
  if (updates.bridge) {
    currentConfig.bridge = { ...currentConfig.bridge, ...updates.bridge };
  }
}

function restart(): void {
  if (bridge) bridge.stop();
  if (webServer) webServer.stop();

  bridge = createBridge(currentConfig);
  bridge.start();
  startServer(currentConfig);
}

function main(): void {
  currentConfig = loadPersistedConfig();
  const logger = new Logger(currentConfig);

  logger.info('========================================');
  logger.info('  Agent Bridge v1.1.1');
  logger.info('  Local Agents <=> Cloud Gateway');
  logger.info('  Backends: OpenClaw + QwenPaw');
  logger.info('========================================');
  logger.info(`Config UI: http://127.0.0.1:${currentConfig.bridge.port}`);
  logger.info(`Cloud WS:  ${currentConfig.cloud.wsUrl}`);
  logger.info(`OpenClaw:  ${currentConfig.openclaw.enabled ? currentConfig.openclaw.baseUrl : 'disabled'}`);
  logger.info(`QwenPaw:   ${currentConfig.qwenpaw.enabled ? currentConfig.qwenpaw.baseUrl : 'disabled'}`);
  logger.info(`Mappings:  ${currentConfig.agentMappings.length} entries`);
  logger.info('========================================');

  if (!currentConfig.cloud.wsUrl || currentConfig.cloud.wsUrl === 'wss://your-cloud-gateway.example.com/ws') {
    logger.warn('⚠️  云端 WebSocket 地址未配置，请通过 Web 界面设置:');
    logger.warn(`   http://127.0.0.1:${currentConfig.bridge.port}`);
  }
  if (!currentConfig.cloud.token) {
    logger.warn('⚠️  云端认证 Token 未配置');
  }

  bridge = createBridge(currentConfig);
  bridge.start();
  startServer(currentConfig);

  process.on('SIGINT', () => {
    if (bridge) bridge.stop();
    if (webServer) webServer.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    if (bridge) bridge.stop();
    if (webServer) webServer.stop();
    process.exit(0);
  });
}

main();
