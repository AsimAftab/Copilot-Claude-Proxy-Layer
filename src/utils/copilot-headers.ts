/**
 * Copilot request header construction.
 *
 * GitHub Copilot's API authenticates the *client* as well as the user: requests
 * that don't look like a supported editor integration are rejected, and newer
 * models are gated behind recent editor versions. All values are env-overridable
 * so they can be bumped without a release.
 */

import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';
import { getMachineId } from './machine-id.js';

export interface CopilotHeaderOptions {
  /** Copilot bearer token */
  token: string;
  /** True when the conversation already contains assistant/tool turns */
  isAgent?: boolean;
  /** True when any message carries image content */
  hasImages?: boolean;
}

/**
 * Build the header set for a Copilot API request.
 */
export function buildCopilotHeaders({
  token,
  isAgent = false,
  hasImages = false,
}: CopilotHeaderOptions): Record<string, string> {
  const { integrationId, editorVersion, pluginVersion, userAgent, apiVersion } =
    config.github.copilot.headers;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Copilot-Integration-Id': integrationId,
    'Editor-Version': editorVersion,
    'Editor-Plugin-Version': pluginVersion,
    'User-Agent': userAgent,
    'X-GitHub-Api-Version': apiVersion,
    'X-Request-Id': uuidv4(),
    'Openai-Intent': 'conversation-panel',
    'Machine-Id': getMachineId(),
    // Copilot uses this to distinguish user-initiated turns from agent loop
    // continuations; agentic turns are routed/throttled differently.
    'X-Initiator': isAgent ? 'agent' : 'user',
  };

  if (hasImages) {
    headers['Copilot-Vision-Request'] = 'true';
  }

  return headers;
}
