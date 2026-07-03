import { BridgeConfig } from './types';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

export class Logger {
  private level: keyof typeof LEVELS;

  constructor(config: BridgeConfig) {
    this.level = config.bridge.logLevel;
  }

  private log(level: keyof typeof LEVELS, msg: string, ...args: unknown[]) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}]`;
    if (level === 'error') {
      console.error(prefix, msg, ...args);
    } else if (level === 'warn') {
      console.warn(prefix, msg, ...args);
    } else {
      console.log(prefix, msg, ...args);
    }
  }

  debug(msg: string, ...args: unknown[]) { this.log('debug', msg, ...args); }
  info(msg: string, ...args: unknown[]) { this.log('info', msg, ...args); }
  warn(msg: string, ...args: unknown[]) { this.log('warn', msg, ...args); }
  error(msg: string, ...args: unknown[]) { this.log('error', msg, ...args); }
}