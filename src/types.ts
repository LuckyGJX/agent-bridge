// ============================================================
// 消息协议定义
// 云端 <-> 本地桥接消息格式
// ============================================================

// --- 云端 -> 本地 ---

/** 云端请求执行 agent 任务 */
export interface CloudMessage {
  requestId: string;
  /** 远程传来的 agent ID（OpenAI model 字段） */
  agentId: string;
  /** 用户消息内容 */
  message: string;
  /** 可选：目标后端（openclaw / qwenpaw），不填则通过映射表查找 */
  backend?: 'openclaw' | 'qwenpaw';
  /** 可选：session key 用于保持会话上下文 */
  sessionKey?: string;
  /** 可选：模型覆盖 */
  model?: string;
  /** 可选：是否流式返回 */
  stream?: boolean;
  /** 可选：用户标识 */
  user?: string;
  /** 新版平台透传的 OpenAI 兼容请求体 */
  body?: Record<string, unknown>;
}

// --- 本地 -> 云端 ---

/** 流式数据块 */
export interface StreamChunk {
  type: 'stream_chunk';
  requestId: string;
  content: string;
  done: boolean;
  finishReason?: string;
}

/** 完整响应（非流式） */
export interface AgentResponse {
  type: 'agent_response';
  requestId: string;
  content: string;
  success: boolean;
  error?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  model?: string;
  /** 实际使用的后端 */
  backend?: string;
}

/** 新版平台非流式响应 */
export interface PlatformResult {
  type: 'result';
  requestId: string;
  status?: number;
  headers?: Record<string, string>;
  text?: string;
  body?: unknown;
}

/** 新版平台流式响应块 */
export interface PlatformChunk {
  type: 'chunk';
  requestId: string;
  data?: string;
  body?: unknown;
}

/** 新版平台流式结束响应 */
export interface PlatformDone {
  type: 'done';
  requestId: string;
  status?: number;
  headers?: Record<string, string>;
}

/** 心跳消息 */
export interface Heartbeat {
  type: 'heartbeat' | 'heartbeat_ack';
  ts: number;
}

/** 注册消息 */
export interface RegisterMessage {
  type: 'register';
  bridgeId: string;
  /** 本地 agent 列表（包含映射后的可用 agent） */
  agents: string[];
  /** 桥接器版本 */
  version: string;
  /** 可用后端 */
  backends: string[];
}

/** 错误消息 */
export interface ErrorMessage {
  type: 'error';
  requestId?: string;
  code: string;
  errorCode?: string;
  message: string;
}

/** 所有消息类型的联合 */
export type BridgeMessage =
  | PlatformResult
  | PlatformChunk
  | PlatformDone
  | Heartbeat
  | RegisterMessage
  | ErrorMessage;

// ============================================================
// Agent 映射
// ============================================================

/** 远程 agentId -> 本地 agentId + 后端 的映射 */
export interface AgentMapping {
  /** 远程传来的 agentId（OpenAI model 字段值） */
  remoteAgentId: string;
  /** 实际调用的本地 agentId */
  localAgentId: string;
  /** 目标后端 */
  backend: 'openclaw' | 'qwenpaw';
}

// ============================================================
// 后端配置
// ============================================================

export interface BackendConfig {
  /** 后端 API 基础地址 */
  baseUrl: string;
  /** 认证 token */
  token: string;
  /** 默认 agent ID */
  defaultAgentId: string;
  /**
   * model 字段前缀
   * openclaw 用 "openclaw/" 前缀路由到 agent
   * qwenpaw 通常不需要前缀，直接用 agentId 或其他方式
   */
  modelPrefix: string;
  /** 是否启用此后端 */
  enabled: boolean;
}

// ============================================================
// 桥接配置
// ============================================================

export interface BridgeConfig {
  cloud: {
    wsUrl: string;
    token: string;
  };
  /** OpenClaw 后端配置 */
  openclaw: BackendConfig;
  /** QwenPaw 后端配置 */
  qwenpaw: BackendConfig;
  /** Agent ID 映射表 */
  agentMappings: AgentMapping[];
  bridge: {
    /** 默认 agent ID（已废弃，向后兼容） */
    agentId: string;
    /** 默认后端 */
    defaultBackend: 'openclaw' | 'qwenpaw';
    /** 本地 Web 配置界面端口 */
    port: number;
    /** 是否自动重连 */
    autoReconnect: boolean;
    /** 重连间隔（毫秒） */
    reconnectIntervalMs: number;
    /** 最大重连次数，0 表示无限 */
    maxReconnectAttempts: number;
    /** 心跳间隔（毫秒） */
    heartbeatIntervalMs: number;
    /** 日志级别 */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
  };
}

// ============================================================
// 连接状态
// ============================================================

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'registered' | 'error';

export interface BridgeState {
  status: ConnectionStatus;
  connectedAt: number | null;
  lastHeartbeat: number | null;
  reconnectAttempts: number;
  messagesReceived: number;
  messagesSent: number;
  errors: Array<{ ts: number; message: string }>;
  bridgeId: string | null;
  cloudBridgeId: string | null;
}

// ============================================================
// 路由结果
// ============================================================

export interface ResolvedRoute {
  backend: 'openclaw' | 'qwenpaw';
  backendConfig: BackendConfig;
  localAgentId: string;
}
