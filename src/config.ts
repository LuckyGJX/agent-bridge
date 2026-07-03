import { BridgeConfig, AgentMapping } from './types';

/**
 * 从环境变量加载配置
 */
export function loadConfig(): BridgeConfig {
  // 解析 agent 映射: BRIDGE_MAPPINGS=remote1:local1:openclaw,remote2:local2:qwenpaw
  const mappingsStr = process.env.BRIDGE_MAPPINGS || '';
  const agentMappings: AgentMapping[] = parseMappings(mappingsStr);

  return {
    cloud: {
      wsUrl: process.env.CLOUD_WS_URL || 'wss://your-cloud-gateway.example.com/ws',
      token: process.env.CLOUD_AUTH_TOKEN || '',
    },
    openclaw: {
      baseUrl: process.env.OPENCLAW_BASE_URL || 'http://127.0.0.1:18789',
      token: process.env.OPENCLAW_TOKEN || '',
      defaultAgentId: process.env.OPENCLAW_AGENT_ID || 'main',
      modelPrefix: 'openclaw/',
      enabled: process.env.OPENCLAW_ENABLED !== 'false',
    },
    qwenpaw: {
      baseUrl: process.env.QWENPAW_BASE_URL || 'http://127.0.0.1:8088',
      token: process.env.QWENPAW_TOKEN || '',
      defaultAgentId: process.env.QWENPAW_AGENT_ID || 'default',
      modelPrefix: '',
      enabled: process.env.QWENPAW_ENABLED !== 'false',
    },
    agentMappings,
    bridge: {
      agentId: process.env.BRIDGE_AGENT_ID || 'main',
      defaultBackend: (process.env.DEFAULT_BACKEND || 'openclaw') as 'openclaw' | 'qwenpaw',
      port: parseInt(process.env.BRIDGE_PORT || '9876', 10),
      autoReconnect: process.env.AUTO_RECONNECT !== 'false',
      reconnectIntervalMs: parseInt(process.env.RECONNECT_INTERVAL || '5000', 10),
      maxReconnectAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS || '0', 10),
      heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10),
      logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
    },
  };
}

/**
 * 解析映射字符串: "remote1:local1:openclaw,remote2:local2:qwenpaw"
 */
function parseMappings(str: string): AgentMapping[] {
  if (!str) return [];
  return str.split(',').map(item => {
    const parts = item.trim().split(':');
    if (parts.length >= 3) {
      return {
        remoteAgentId: parts[0],
        localAgentId: parts[1],
        backend: parts[2] as 'openclaw' | 'qwenpaw',
      };
    }
    // 兼容两段: "remote:local" 默认使用 openclaw
    if (parts.length === 2) {
      return {
        remoteAgentId: parts[0],
        localAgentId: parts[1],
        backend: 'openclaw',
      };
    }
    return null;
  }).filter(Boolean) as AgentMapping[];
}
