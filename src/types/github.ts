export interface GithubUserInfo {
  username: string;
  email?: string;
}

/**
 * Per-plan API hosts returned by the Copilot token exchange.
 * Individual plans resolve to `https://api.individual.githubcopilot.com`,
 * business/enterprise plans to their own hosts.
 */
export interface CopilotEndpoints {
  api?: string;
  telemetry?: string;
  proxy?: string;
  'origin-tracker'?: string;
}

export interface CopilotToken {
  token: string;
  expires_at: number;
  refresh_in: number;
  chat_enabled: boolean;
  sku: string;
  telemetry: string;
  tracking_id: string;
  endpoints?: CopilotEndpoints;
}

export interface VerificationResponse {
  verification_uri: string;
  user_code: string;
  expires_in: number;
  interval: number;
  status: 'pending_verification' | 'authenticated';
}

export interface AuthenticationStatus {
  status: 'authenticated' | 'unauthenticated' | 'pending_verification' | 'error';
  expiresAt?: number;
  error?: string;
}

export interface CopilotCompletionChoice {
  text: string;
  index: number;
  logprobs: null;
  finish_reason: string | null;
}

export interface CopilotCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: CopilotCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }
}
