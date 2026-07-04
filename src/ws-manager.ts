import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { rootCertificates } from 'node:tls';
import { BridgeConfig, BridgeMessage, BridgeState, CloudMessage, ConnectionStatus, RegisterMessage } from './types';
import { Logger } from './logger';
import { AgentRouter } from './router';

/**
 * 管理云端 WebSocket 连接的生命周期
 */
export class WebSocketManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: BridgeConfig;
  private logger: Logger;
  private state: BridgeState;
  private router: AgentRouter;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(config: BridgeConfig, router: AgentRouter) {
    super();
    this.config = config;
    this.logger = new Logger(config);
    this.router = router;
    this.state = {
      status: 'disconnected',
      connectedAt: null,
      lastHeartbeat: null,
      reconnectAttempts: 0,
      messagesReceived: 0,
      messagesSent: 0,
      errors: [],
      bridgeId: this.generateBridgeId(),
      cloudBridgeId: null,
    };
  }

  private generateBridgeId(): string {
    const hostname = (() => {
      try { return require('os').hostname(); } catch { return 'unknown'; }
    })();
    return `bridge-${hostname}-${Date.now().toString(36)}`;
  }

  /** 连接云端 WebSocket */
  connect(): void {
    if (this.destroyed) return;
    this.setState('connecting');
    this.logger.info(`Connecting to cloud: ${this.config.cloud.wsUrl}`);

    try {
      this.ws = new WebSocket(this.config.cloud.wsUrl, {
        ca: [...rootCertificates],
        headers: {
          Authorization: `Bearer ${this.config.cloud.token}`,
          'x-bridge-id': this.state.bridgeId!,
          'x-bridge-version': '1.0.0',
        },
      });
    } catch (err) {
      this.logger.error('Failed to create WebSocket:', err);
      this.handleDisconnect();
      return;
    }

    this.ws.on('open', () => {
      this.logger.info('WebSocket connected, sending register...');
      this.setState('connected');
      this.state.connectedAt = Date.now();
      this.state.reconnectAttempts = 0;
      this.sendRegister();
      this.startHeartbeat();
      this.emit('connected');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.state.lastHeartbeat = Date.now();
      this.state.messagesReceived++;
      try {
        const raw = JSON.parse(data.toString());
        this.logger.debug(`Received: ${raw.type}`, raw);
        this.handleMessage(raw);
      } catch (err) {
        this.logger.error('Failed to parse message:', err);
      }
    });

    this.ws.on('close', (code, reason) => {
      this.logger.warn(`WebSocket closed: code=${code} reason=${reason}`);
      this.handleDisconnect();
    });

    this.ws.on('error', (err) => {
      this.logger.error('WebSocket error:', err.message);
      this.addError(err.message);
      this.setState('error');
      this.emit('error', err);
    });
  }

  /** 发送注册消息 */
  private sendRegister(): void {
    const msg: RegisterMessage = {
      type: 'register',
      bridgeId: this.state.bridgeId!,
      agents: this.getLocalAgents(),
      version: '1.0.0',
      backends: this.getBackends(),
    };
    this.send(msg);
  }

  /** 获取本地可用的 agent 列表 */
  private getLocalAgents(): string[] {
    return this.router.getRegisteredAgents();
  }

  /** 获取可用后端列表 */
  private getBackends(): string[] {
    return this.router.getAvailableBackends();
  }

  /** 发送消息到云端 */
  send(msg: BridgeMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn('Cannot send, WebSocket not open');
      return;
    }
    const data = JSON.stringify(msg);
    this.ws.send(data);
    this.state.messagesSent++;
    this.logger.debug(`Sent: ${msg.type}`);
  }

  /** 处理接收到的消息 */
  private handleMessage(raw: any): void {
    const type = raw.type as string;
    switch (type) {
      case 'register_ack':
      case 'connected':
        this.logger.info(`Registered with cloud: ${raw.userId || 'connected'}`);
        this.state.cloudBridgeId = raw.agentId || 'connected';
        const cloudHb = raw.heartbeatIntervalMs;
        if (cloudHb && cloudHb > 0 && cloudHb !== this.config.bridge.heartbeatIntervalMs) {
          this.logger.info(`Cloud heartbeat: ${cloudHb}ms`);
          this.config.bridge.heartbeatIntervalMs = cloudHb;
          this.stopHeartbeat();
          this.startHeartbeat();
        }
        this.setState('registered');
        this.emit('registered', raw);
        break;

      case 'invoke': {
        const msg = this.normalizeInvoke(raw);
        this.logger.info(`Invoke received: ${msg.requestId} -> ${msg.agentId}`);
        this.emit('invoke', msg);
        break;
      }

      case 'heartbeat_ack':
      case 'pong':
        this.emit('heartbeat_ack', raw);
        break;

      case 'error':
        this.logger.error(`Cloud error: ${raw.code} - ${raw.message}`);
        this.addError(`Cloud: ${raw.code} - ${raw.message}`);
        this.emit('cloud_error', raw);
        break;

      default:
        this.logger.debug(`Unhandled message type: ${type}`);
        this.emit('message', raw);
    }
  }

  private normalizeInvoke(raw: any): CloudMessage {
    const body = this.toRecord(raw.body);
    return {
      requestId: String(raw.requestId || ''),
      agentId: String(raw.agentId || ''),
      message: this.extractMessage(body),
      stream: raw.stream === true || body.stream === true,
      sessionKey: this.optionalString(body.session_id),
      model: this.optionalString(body.model),
      user: this.optionalString(body.user),
      body,
    };
  }

  private toRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
  }

  private extractMessage(body: Record<string, unknown>): string {
    const messages = body.messages;
    if (Array.isArray(messages) && messages.length > 0) {
      const normalized = messages
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
      const lastUser = [...normalized].reverse().find(item => item.role === 'user');
      const last = lastUser || normalized[normalized.length - 1];
      return this.contentToText(last?.content);
    }

    return this.contentToText(body.message || body.prompt || body.input);
  }

  private contentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map(item => {
          if (typeof item === 'string') return item;
          if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
          const part = item as Record<string, unknown>;
          return this.contentToText(part.text || part.content);
        })
        .filter(Boolean)
        .join('\n');
    }
    if (content && typeof content === 'object') {
      const record = content as Record<string, unknown>;
      return this.contentToText(record.text || record.content);
    }
    return '';
  }

  /** 开始心跳 */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat', ts: Date.now() });
    }, this.config.bridge.heartbeatIntervalMs);
  }

  /** 停止心跳 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 处理断开连接 */
  private handleDisconnect(): void {
    this.stopHeartbeat();
    this.setState('disconnected');
    this.emit('disconnected');

    if (this.destroyed) return;
    if (!this.config.bridge.autoReconnect) return;

    const max = this.config.bridge.maxReconnectAttempts;
    if (max > 0 && this.state.reconnectAttempts >= max) {
      this.logger.error(`Max reconnect attempts (${max}) reached, giving up`);
      this.setState('error');
      this.emit('max_reconnect');
      return;
    }

    const delay = this.config.bridge.reconnectIntervalMs;
    this.state.reconnectAttempts++;
    this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.state.reconnectAttempts}${max > 0 ? `/${max}` : ''})...`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** 更新连接状态 */
  private setState(status: ConnectionStatus): void {
    this.state.status = status;
    this.emit('status_change', status, this.getState());
  }

  /** 获取当前状态 */
  getState(): BridgeState {
    return { ...this.state };
  }

  /** 添加错误记录 */
  private addError(message: string): void {
    this.state.errors.push({ ts: Date.now(), message });
    // 只保留最近 50 条错误
    if (this.state.errors.length > 50) {
      this.state.errors = this.state.errors.slice(-50);
    }
  }

  /** 手动断开连接 */
  disconnect(): void {
    this.logger.info('Disconnecting...');
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.destroyed = true;
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
  }

  /** 连接状态是否就绪 */
  isReady(): boolean {
    return this.state.status === 'registered';
  }
}
