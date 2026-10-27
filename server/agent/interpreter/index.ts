import { config } from '../../config';
import { LlmInterpreter } from './llm';
import { OfflineInterpreter } from './offline';
import type { Interpreter } from './types';

export function createInterpreter(): Interpreter {
  return config.llm.enabled ? new LlmInterpreter(config.llm.model) : new OfflineInterpreter();
}

export type { Interpreter } from './types';
