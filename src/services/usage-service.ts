import { logger } from '../utils/logger.js';

// In-memory usage tracking
// Note: In a production environment with multiple instances,
// you might want to use Redis or a database for persistence
interface UsageMetrics {
  requestCount: number;
  tokenCount: number;
  lastRequestTime: number;
  startTime: number;
  // Track tokens used per minute window
  tokenTimestamps: Array<{
    tokens: number;
    timestamp: number;
  }>;
}

interface ApiKeyUsage {
  [key: string]: UsageMetrics;
}

const usage: ApiKeyUsage = {};

/** Sliding-window request timestamps per session, used for rate limiting. */
const requestTimestamps: Record<string, number[]> = {};

/**
 * Initialize usage metrics for a session
 * @param sessionId Unique identifier for the session (typically a hashed token or IP)
 */
export function initializeUsage(sessionId: string): void {
  if (!usage[sessionId]) {
    usage[sessionId] = {
      requestCount: 0,
      tokenCount: 0,
      lastRequestTime: Date.now(),
      startTime: Date.now(),
      tokenTimestamps: []
    };
    logger.debug(`Initialized usage tracking for session: ${sessionId.substring(0, 8)}...`);
  }
}

/**
 * Track a request for usage metrics
 * @param sessionId Unique identifier for the session
 * @param tokenCount Number of tokens used in the request
 */
export function trackRequest(sessionId: string, tokenCount = 0): void {
  if (!usage[sessionId]) {
    initializeUsage(sessionId);
  }
  
  const now = Date.now();
  usage[sessionId].requestCount += 1;
  usage[sessionId].tokenCount += tokenCount;
  usage[sessionId].lastRequestTime = now;
  
  // Record token usage with timestamp for rate limiting over time
  if (tokenCount > 0) {
    usage[sessionId].tokenTimestamps.push({
      tokens: tokenCount,
      timestamp: now
    });
  }
  
  // Clean up old token timestamps (older than 5 minutes)
  const fiveMinutesAgo = now - 5 * 60 * 1000;
  usage[sessionId].tokenTimestamps = usage[sessionId].tokenTimestamps.filter(
    entry => entry.timestamp >= fiveMinutesAgo
  );
  
  logger.debug(`Tracked request for session ${sessionId.substring(0, 8)}...: +${tokenCount} tokens`);
}

/**
 * Get usage metrics for a session
 * @param sessionId Unique identifier for the session
 * @returns Usage metrics or null if session not found
 */
export function getUsage(sessionId: string): UsageMetrics | null {
  return usage[sessionId] || null;
}

/**
 * Get all usage metrics
 * @returns All usage metrics
 */
export function getAllUsage(): ApiKeyUsage {
  return { ...usage };
}

/**
 * Get token usage for a specified time window
 * @param sessionId Unique identifier for the session
 * @param windowMs Time window in milliseconds
 * @returns Token count within the specified window
 */
export function getTokenUsageInWindow(sessionId: string, windowMs: number): number {
  if (!usage[sessionId]) {
    return 0;
  }
  
  const now = Date.now();
  const windowStart = now - windowMs;
  
  // Sum up tokens used within the window
  return usage[sessionId].tokenTimestamps
    .filter(entry => entry.timestamp >= windowStart)
    .reduce((sum, entry) => sum + entry.tokens, 0);
}

/**
 * Check if a session has exceeded its request rate limit.
 *
 * Uses a sliding 60-second window. An earlier implementation compared the
 * lifetime cumulative request count against the per-minute limit, which meant a
 * long agentic session permanently rate-limited itself once the total was
 * exceeded.
 *
 * @param sessionId Unique identifier for the session
 * @param maxRequestsPerMinute Maximum requests allowed per minute
 * @returns Whether rate limit is exceeded and retry-after time in seconds
 */
export function checkRateLimit(
  sessionId: string,
  maxRequestsPerMinute = 60
): { limited: boolean; retryAfter: number } {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const windowStart = now - windowMs;

  const timestamps = (requestTimestamps[sessionId] ?? []).filter((t) => t >= windowStart);

  if (timestamps.length >= maxRequestsPerMinute) {
    const oldest = timestamps[0];
    const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
    requestTimestamps[sessionId] = timestamps;
    return { limited: true, retryAfter: Math.max(1, retryAfter) };
  }

  timestamps.push(now);
  requestTimestamps[sessionId] = timestamps;

  return { limited: false, retryAfter: 0 };
}

/**
 * Reset usage metrics for a session
 * @param sessionId Unique identifier for the session
 */
export function resetUsage(sessionId: string): void {
  delete requestTimestamps[sessionId];

  if (usage[sessionId]) {
    usage[sessionId] = {
      requestCount: 0,
      tokenCount: 0,
      lastRequestTime: Date.now(),
      startTime: Date.now(),
      tokenTimestamps: []
    };
    logger.info(`Reset usage metrics for session: ${sessionId.substring(0, 8)}...`);
  }
}

/**
 * Get usage summary with aggregated statistics
 * @returns Summary of usage statistics
 */
export function getUsageSummary(): {
  totalRequests: number;
  totalTokens: number;
  activeSessions: number;
  averageTokensPerRequest: number;
} {
  const sessions = Object.keys(usage);
  const totalRequests = sessions.reduce((sum, key) => sum + usage[key].requestCount, 0);
  const totalTokens = sessions.reduce((sum, key) => sum + usage[key].tokenCount, 0);
  
  return {
    totalRequests,
    totalTokens,
    activeSessions: sessions.length,
    averageTokensPerRequest: totalRequests > 0 ? totalTokens / totalRequests : 0
  };
}
