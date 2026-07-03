import { AgentResponse, BridgeConfig, CloudMessage, StreamChunk } from './types';
import { WebSocketManager } from './ws-manager';
import { BackendClient } from './backend-client';
import { AgentRouter } from './router';
import { Logger } from './logger';

/**
 * Agent Bridge 核心引擎
 * 连接云端 WebSocket 并转发请求到本地后端（OpenClaw / QwenPaw）
 */
export class AgentBridge {
  private config: BridgeConfig;
  private wsManager: WebSocketManager;
  private backendClient: BackendClient;
  private router: AgentRouter;
  private logger: Logger;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.logger = new Logger(config);
    this.router = new AgentRouter(config);
    this.wsManager = new WebSocketManager(config, this.router);
    this.backendClient = new BackendClient(config);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.wsManager.on('invoke', async (msg: CloudMessage) => {
      this.logger.info(`Agent request: ${msg.requestId} remoteId=${msg.agentId}`);

      try {
        const route = this.router.resolve(msg);
        this.logger.info(`Routed: ${msg.agentId} -> ${route.backend}/${route.localAgentId}`);

        if (msg.stream) {
          await this.handleStreamRequest(msg, route);
        } else {
          await this.handleNonStreamRequest(msg, route);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Routing error: ${errMsg}`);
        this.wsManager.send({
          type: 'error',
          requestId: msg.requestId,
          code: 'ROUTING_ERROR',
          errorCode: 'routing_error',
          message: errMsg,
        });
      }
    });

    this.wsManager.on('status_change', (status) => {
      this.logger.info(`Connection status: ${status}`);
    });

    this.wsManager.on('error', (err) => {
      this.logger.error(`WS error: ${err.message}`);
    });
  }

  private async handleNonStreamRequest(msg: CloudMessage, route: ReturnType<AgentRouter['resolve']>): Promise<void> {
    try {
      const response = await this.backendClient.executeRequest(route, msg);
      if (!response.success) {
        this.wsManager.send({
          type: 'error',
          requestId: msg.requestId,
          code: 'EXECUTION_ERROR',
          errorCode: 'local_execution_error',
          message: response.error || 'Local backend execution failed',
        });
        return;
      }

      this.wsManager.send({
        type: 'result',
        requestId: msg.requestId,
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify(this.toOpenAICompletion(msg, route, response)),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.wsManager.send({
        type: 'error',
        requestId: msg.requestId,
        code: 'EXECUTION_ERROR',
        errorCode: 'execution_error',
        message: errMsg,
      });
    }
  }

  private async handleStreamRequest(msg: CloudMessage, route: ReturnType<AgentRouter['resolve']>): Promise<void> {
    try {
      for await (const chunk of this.backendClient.executeStreamRequest(route, msg)) {
        if (chunk.done) {
          this.wsManager.send({
            type: 'chunk',
            requestId: msg.requestId,
            data: `data: ${JSON.stringify(this.toOpenAIChunk(msg, route, chunk))}\n\n`,
          });
          this.wsManager.send({
            type: 'chunk',
            requestId: msg.requestId,
            data: 'data: [DONE]\n\n',
          });
          this.wsManager.send({
            type: 'done',
            requestId: msg.requestId,
            status: 200,
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          });
          return;
        }

        if (chunk.content) {
          this.wsManager.send({
            type: 'chunk',
            requestId: msg.requestId,
            data: `data: ${JSON.stringify(this.toOpenAIChunk(msg, route, chunk))}\n\n`,
          });
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.wsManager.send({
        type: 'error',
        requestId: msg.requestId,
        code: 'STREAM_ERROR',
        errorCode: 'stream_error',
        message: errMsg,
      });
    }
  }

  private toOpenAICompletion(msg: CloudMessage, route: ReturnType<AgentRouter['resolve']>, response: AgentResponse) {
    return {
      id: `chatcmpl-${msg.requestId}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: this.responseModel(msg, route, response.model),
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: response.content,
          },
          finish_reason: 'stop',
        },
      ],
      usage: response.usage
        ? {
            prompt_tokens: response.usage.promptTokens,
            completion_tokens: response.usage.completionTokens,
            total_tokens: response.usage.totalTokens,
          }
        : undefined,
    };
  }

  private toOpenAIChunk(msg: CloudMessage, route: ReturnType<AgentRouter['resolve']>, chunk: StreamChunk) {
    return {
      id: `chatcmpl-${msg.requestId}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: this.responseModel(msg, route),
      choices: [
        {
          index: 0,
          delta: chunk.done ? {} : { content: chunk.content },
          finish_reason: chunk.done ? chunk.finishReason || 'stop' : null,
        },
      ],
    };
  }

  private responseModel(msg: CloudMessage, route: ReturnType<AgentRouter['resolve']>, fallback?: string): string {
    const requestModel = msg.body?.model;
    if (typeof requestModel === 'string' && requestModel) return requestModel;
    return fallback || route.localAgentId || msg.agentId;
  }

  start(): void {
    this.logger.info('Agent Bridge starting...');
    this.logger.info(`Cloud WS: ${this.config.cloud.wsUrl}`);

    const backends = this.router.getAvailableBackends();
    for (const b of backends) {
      const backendConfig = b === 'openclaw' ? this.config.openclaw : this.config.qwenpaw;
      this.logger.info(`Backend [${b}]: ${backendConfig.baseUrl} (agent=${backendConfig.defaultAgentId})`);
    }

    if (this.config.agentMappings.length > 0) {
      this.logger.info('Agent mappings:');
      for (const m of this.config.agentMappings) {
        this.logger.info(`  ${m.remoteAgentId} -> ${m.backend}/${m.localAgentId}`);
      }
    } else {
      this.logger.info(`Default backend: ${this.config.bridge.defaultBackend}, no mappings configured`);
      this.logger.info('Configure with BRIDGE_MAPPINGS=remoteName:localName:backend');
    }

    this.wsManager.connect();
  }

  stop(): void {
    this.logger.info('Agent Bridge stopping...');
    this.wsManager.disconnect();
  }

  getState() {
    return this.wsManager.getState();
  }

  getWsManager(): WebSocketManager {
    return this.wsManager;
  }

  getRouter(): AgentRouter {
    return this.router;
  }
}
