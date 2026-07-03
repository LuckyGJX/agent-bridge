import { BridgeConfig, CloudMessage, ResolvedRoute } from './types';

/**
 * Agent ID 路由器
 * 根据远程 agentId 查找映射，决定路由到哪个后端
 */
export class AgentRouter {
  private config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  /**
   * 解析 agent 请求，决定后端和本地 agentId
   */
  resolve(msg: CloudMessage): ResolvedRoute {
    const remoteAgentId = msg.agentId || '';

    // 1. 如果消息明确指定了 backend，直接使用
    if (msg.backend) {
      const backend = msg.backend;
      const backendConfig = this.getBackendConfig(backend);
      if (!backendConfig.enabled) {
        throw new Error(`Backend "${backend}" is disabled`);
      }
      return {
        backend,
        backendConfig,
        localAgentId: this.resolveLocalAgentId(backend, remoteAgentId),
      };
    }

    // 2. 在映射表中查找
    const mapping = this.config.agentMappings.find(m => m.remoteAgentId === remoteAgentId);
    if (mapping) {
      const backendConfig = this.getBackendConfig(mapping.backend);
      if (!backendConfig.enabled) {
        throw new Error(`Backend "${mapping.backend}" is disabled (mapped from "${remoteAgentId}")`);
      }
      return {
        backend: mapping.backend,
        backendConfig,
        localAgentId: mapping.localAgentId,
      };
    }

    // 3. 尝试从 remoteAgentId 中解析 openclaw:xxx 或 qwenpaw:xxx 前缀
    if (remoteAgentId.startsWith('openclaw/') || remoteAgentId.startsWith('openclaw:')) {
      const localAgentId = remoteAgentId.replace(/^openclaw[\/:]/, '');
      const backendConfig = this.getBackendConfig('openclaw');
      if (!backendConfig.enabled) {
        throw new Error('OpenClaw backend is disabled');
      }
      return { backend: 'openclaw', backendConfig, localAgentId };
    }

    if (remoteAgentId.startsWith('qwenpaw/') || remoteAgentId.startsWith('qwenpaw:')) {
      const localAgentId = remoteAgentId.replace(/^qwenpaw[\/:]/, '');
      const backendConfig = this.getBackendConfig('qwenpaw');
      if (!backendConfig.enabled) {
        throw new Error('QwenPaw backend is disabled');
      }
      return { backend: 'qwenpaw', backendConfig, localAgentId };
    }

    // 4. 回退到默认后端
    const defaultBackend = this.config.bridge.defaultBackend;
    const backendConfig = this.getBackendConfig(defaultBackend);
    if (!backendConfig.enabled) {
      // 尝试另一个
      const other = defaultBackend === 'openclaw' ? 'qwenpaw' : 'openclaw';
      const otherConfig = this.getBackendConfig(other);
      if (!otherConfig.enabled) {
        throw new Error('No enabled backend available');
      }
      return {
        backend: other,
        backendConfig: otherConfig,
        localAgentId: this.resolveLocalAgentId(other, remoteAgentId),
      };
    }
    return {
      backend: defaultBackend,
      backendConfig,
      localAgentId: this.resolveLocalAgentId(defaultBackend, remoteAgentId),
    };
  }

  private getBackendConfig(backend: 'openclaw' | 'qwenpaw') {
    return backend === 'openclaw' ? this.config.openclaw : this.config.qwenpaw;
  }

  private resolveLocalAgentId(backend: 'openclaw' | 'qwenpaw', remoteAgentId: string): string {
    const cfg = backend === 'openclaw' ? this.config.openclaw : this.config.qwenpaw;
    return remoteAgentId || cfg.defaultAgentId;
  }

  /**
   * 获取所有已在映射表中注册的 agent 列表（用于注册时上报）
   */
  getRegisteredAgents(): string[] {
    const agents = new Set<string>();
    for (const m of this.config.agentMappings) {
      agents.add(m.remoteAgentId);
    }
    // 也上报默认 agent
    if (this.config.openclaw.enabled) {
      agents.add(this.config.openclaw.defaultAgentId);
    }
    if (this.config.qwenpaw.enabled) {
      agents.add(this.config.qwenpaw.defaultAgentId);
    }
    return Array.from(agents);
  }

  /**
   * 获取可用后端列表
   */
  getAvailableBackends(): string[] {
    const backends: string[] = [];
    if (this.config.openclaw.enabled) backends.push('openclaw');
    if (this.config.qwenpaw.enabled) backends.push('qwenpaw');
    return backends;
  }
}