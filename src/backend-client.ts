import { BridgeConfig, CloudMessage, AgentResponse, StreamChunk, ResolvedRoute } from './types';
import { Logger } from './logger';

// ============================================================
// OpenClaw OpenAI 兼容格式
// ============================================================

interface OpenAIChoice {
  index: number;
  message?: { role: string; content: string };
  delta?: { role?: string; content?: string };
  finish_reason: string | null;
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ============================================================
// QwenPaw 自定义格式
// ============================================================

interface QwenPawEvent {
  sequence_number?: number;
  object?: string;
  status: string;
  id?: string;
  type?: string;
  role?: string;
  output?: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
  error?: { message: string; code?: string };
  text?: string;
  delta?: boolean;
  msg_id?: string;
  index?: number;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  metadata?: Record<string, unknown>;
}

type JsonRecord = Record<string, unknown>;

/**
 * 多后端客户端
 * OpenClaw: OpenAI 兼容 API (POST /v1/chat/completions)
 * QwenPaw: 自定义 REST API (POST /api/console/chat)
 */
export class BackendClient {
  private config: BridgeConfig;
  private logger: Logger;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.logger = new Logger(config);
  }

  // ============================================================
  // 公共接口
  // ============================================================

  async executeRequest(route: ResolvedRoute, msg: CloudMessage): Promise<AgentResponse> {
    if (route.backend === 'qwenpaw') {
      return this.executeQwenPawRequest(route, msg);
    }
    return this.executeOpenClawRequest(route, msg);
  }

  async *executeStreamRequest(route: ResolvedRoute, msg: CloudMessage): AsyncGenerator<StreamChunk> {
    if (route.backend === 'qwenpaw') {
      yield* this.executeQwenPawStream(route, msg);
    } else {
      yield* this.executeOpenClawStream(route, msg);
    }
  }

  // ============================================================
  // OpenClaw (OpenAI 兼容)
  // ============================================================

  private buildOpenClawHeaders(route: ResolvedRoute, msg: CloudMessage): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (route.backendConfig.token) {
      headers['Authorization'] = `Bearer ${route.backendConfig.token}`;
    }
    return headers;
  }

  private buildOpenClawBody(route: ResolvedRoute, msg: CloudMessage, stream: boolean): Record<string, unknown> {
    const model = `${route.backendConfig.modelPrefix}${route.localAgentId}`;
    const requestBody = this.getRequestBody(msg);
    const body: Record<string, unknown> = {
      ...requestBody,
      model,
      messages: this.getOpenAIMessages(msg),
      stream,
    };
    if ((msg.sessionKey || msg.user) && !body.user && !body.session_id) {
      body.user = msg.sessionKey || msg.user;
    }
    return body;
  }

  private async executeOpenClawRequest(route: ResolvedRoute, msg: CloudMessage): Promise<AgentResponse> {
    const url = `${route.backendConfig.baseUrl}/v1/chat/completions`;
    const body = this.buildOpenClawBody(route, msg, false);
    const headers = this.buildOpenClawHeaders(route, msg);

    this.logger.debug(`[openclaw] POST ${url}`);

    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const errText = await res.text();
        return { type: 'agent_response', requestId: msg.requestId, content: '', success: false, error: `HTTP ${res.status}: ${errText}`, backend: 'openclaw' };
      }
      const data = (await res.json()) as OpenAIResponse;
      const content = data.choices?.[0]?.message?.content || '';
      return {
        type: 'agent_response', requestId: msg.requestId, content, success: true,
        usage: data.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens } : undefined,
        model: data.model, backend: 'openclaw',
      };
    } catch (err) {
      return { type: 'agent_response', requestId: msg.requestId, content: '', success: false, error: String(err), backend: 'openclaw' };
    }
  }

  private async *executeOpenClawStream(route: ResolvedRoute, msg: CloudMessage): AsyncGenerator<StreamChunk> {
    const url = `${route.backendConfig.baseUrl}/v1/chat/completions`;
    const body = this.buildOpenClawBody(route, msg, true);
    const headers = this.buildOpenClawHeaders(route, msg);

    this.logger.debug(`[openclaw] SSE POST ${url}`);

    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        yield { type: 'stream_chunk', requestId: msg.requestId, content: '', done: true, finishReason: 'error' };
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) {
        yield { type: 'stream_chunk', requestId: msg.requestId, content: '', done: true, finishReason: 'error' };
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const chunk of this.parseOpenAISSE(msg.requestId, lines)) {
          yield chunk;
        }
      }
    } catch (err) {
      this.logger.error(`[openclaw] Stream failed: ${err}`);
      yield { type: 'stream_chunk', requestId: msg.requestId, content: '', done: true, finishReason: 'error' };
    }
  }

  private *parseOpenAISSE(requestId: string, lines: string[]): Generator<StreamChunk> {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') {
        yield { type: 'stream_chunk', requestId, content: '', done: true, finishReason: 'stop' };
        return;
      }
      try {
        const parsed = JSON.parse(data) as OpenAIResponse;
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) {
          yield { type: 'stream_chunk', requestId, content: delta.content, done: false };
        }
        if (parsed.choices?.[0]?.finish_reason) {
          yield { type: 'stream_chunk', requestId, content: '', done: true, finishReason: parsed.choices[0].finish_reason };
        }
      } catch { /* skip */ }
    }
  }

  // ============================================================
  // QwenPaw (自定义 REST API)
  // ============================================================

  private buildQwenPawHeaders(route: ResolvedRoute, msg: CloudMessage): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Agent-Id': route.localAgentId,
    };
    if (route.backendConfig.token) {
      headers['Authorization'] = `Bearer ${route.backendConfig.token}`;
    }
    return headers;
  }

  private buildQwenPawBody(msg: CloudMessage): Record<string, unknown> {
    const requestBody = this.getRequestBody(msg);
    return {
      input: this.getQwenPawInput(msg),
      session_id: this.optionalString(requestBody.session_id) || msg.sessionKey || msg.user || `bridge-${msg.requestId}`,
      user_id: this.optionalString(requestBody.user) || msg.user || 'bridge',
      channel: 'console',
    };
  }

  /**
   * QwenPaw 非流式请求：SSE 收集完毕后返回完整内容
   */
  private async executeQwenPawRequest(route: ResolvedRoute, msg: CloudMessage): Promise<AgentResponse> {
    const url = `${route.backendConfig.baseUrl}/api/console/chat`;
    const body = this.buildQwenPawBody(msg);
    const headers = this.buildQwenPawHeaders(route, msg);

    this.logger.debug(`[qwenpaw] POST ${url}`);

    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const errText = await res.text();
        return { type: 'agent_response', requestId: msg.requestId, content: '', success: false, error: `HTTP ${res.status}: ${errText}`, backend: 'qwenpaw' };
      }

      const reader = res.body?.getReader();
      if (!reader) {
        return { type: 'agent_response', requestId: msg.requestId, content: '', success: false, error: 'No response body', backend: 'qwenpaw' };
      }

      let fullContent = '';
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          try {
            const event = JSON.parse(trimmed.slice(5).trim()) as QwenPawEvent;
            if (event.status === 'failed') {
              return { type: 'agent_response', requestId: msg.requestId, content: '', success: false, error: event.error?.message || 'QwenPaw execution failed', backend: 'qwenpaw' };
            }
            if (event.object === 'content' && event.delta && event.text) {
              fullContent += event.text;
            }
            if (event.output) {
              for (const item of event.output) {
                if (item.role === 'assistant') {
                  for (const c of item.content || []) {
                    if (c.type === 'text' && c.text) fullContent += c.text;
                  }
                }
              }
            }
          } catch { /* skip */ }
        }
      }
      return { type: 'agent_response', requestId: msg.requestId, content: fullContent, success: true, backend: 'qwenpaw' };
    } catch (err) {
      return { type: 'agent_response', requestId: msg.requestId, content: '', success: false, error: String(err), backend: 'qwenpaw' };
    }
  }

  /**
   * QwenPaw SSE 流式请求
   */
  private async *executeQwenPawStream(route: ResolvedRoute, msg: CloudMessage): AsyncGenerator<StreamChunk> {
    const url = `${route.backendConfig.baseUrl}/api/console/chat`;
    const body = this.buildQwenPawBody(msg);
    const headers = this.buildQwenPawHeaders(route, msg);

    this.logger.debug(`[qwenpaw] SSE POST ${url}`);

    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        yield { type: 'stream_chunk', requestId: msg.requestId, content: '', done: true, finishReason: 'error' };
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) {
        yield { type: 'stream_chunk', requestId: msg.requestId, content: '', done: true, finishReason: 'error' };
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const chunk of this.parseQwenPawSSE(msg.requestId, lines)) {
          yield chunk;
        }
      }
    } catch (err) {
      this.logger.error(`[qwenpaw] Stream failed: ${err}`);
      yield { type: 'stream_chunk', requestId: msg.requestId, content: '', done: true, finishReason: 'error' };
    }
  }

  /**
   * 解析 QwenPaw SSE 事件流
   * 格式: object="content" + delta=true + text="..." (增量)
   * 兼容: object="response" + output 数组 (聚合)
   */
  private *parseQwenPawSSE(requestId: string, lines: string[]): Generator<StreamChunk> {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      try {
        const event = JSON.parse(trimmed.slice(5).trim()) as QwenPawEvent;
        if (event.status === 'failed') {
          yield { type: 'stream_chunk', requestId, content: '', done: true, finishReason: 'error' };
          return;
        }
        if (event.status === 'completed') {
          yield { type: 'stream_chunk', requestId, content: '', done: true, finishReason: 'stop' };
          return;
        }
        // 增量文本 (object="content", delta=true, text="...")
        if (event.object === 'content' && event.delta && event.text) {
          yield { type: 'stream_chunk', requestId, content: event.text, done: false };
        }
        // 兼容旧格式 output 数组
        if (event.output) {
          for (const item of event.output) {
            if (item.role === 'assistant') {
              for (const c of item.content || []) {
                if (c.type === 'text' && c.text) {
                  yield { type: 'stream_chunk', requestId, content: c.text, done: false };
                }
              }
            }
          }
        }
      } catch { /* skip */ }
    }
  }

  private getRequestBody(msg: CloudMessage): JsonRecord {
    if (!msg.body || typeof msg.body !== 'object' || Array.isArray(msg.body)) return {};
    return msg.body;
  }

  private getOpenAIMessages(msg: CloudMessage): Array<{ role: string; content: unknown }> {
    const requestBody = this.getRequestBody(msg);
    const messages = requestBody.messages;
    if (Array.isArray(messages) && messages.length > 0) {
      return messages
        .filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        .map(item => ({
          role: typeof item.role === 'string' ? item.role : 'user',
          content: item.content ?? '',
        }));
    }
    return [{ role: 'user', content: msg.message }];
  }

  private getQwenPawInput(msg: CloudMessage): Array<{ role: string; content: Array<{ type: string; text: string }> }> {
    const messages = this.getOpenAIMessages(msg);
    const input = messages
      .map(item => ({
        role: item.role,
        content: [{ type: 'text', text: this.contentToText(item.content) }],
      }))
      .filter(item => item.content[0].text.trim().length > 0);

    if (input.length > 0) return input;
    return [{
      role: 'user',
      content: [{ type: 'text', text: msg.message }],
    }];
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
  }

  private contentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map(item => {
          if (typeof item === 'string') return item;
          if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
          const part = item as JsonRecord;
          return this.contentToText(part.text || part.content);
        })
        .filter(Boolean)
        .join('\n');
    }
    if (content && typeof content === 'object') {
      const record = content as JsonRecord;
      return this.contentToText(record.text || record.content);
    }
    return '';
  }
}
