import { Request, Response, NextFunction } from 'express';
import { checkRateLimit } from '../services/usage-service.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import crypto from 'crypto';

/**
 * Request-rate limiting.
 *
 * Deliberately request-count based only. Token-based caps were removed: an
 * agentic Claude Code turn legitimately sends very large contexts and bursts of
 * rapid tool-loop requests, so per-request token ceilings simply broke valid
 * traffic. Set DISABLE_RATE_LIMIT=1 to bypass entirely.
 *
 * @param maxRequestsPerMinute Optional override for max requests per minute
 */
export function rateLimiter(maxRequestsPerMinute?: number) {
  return function (req: Request, res: Response, next: NextFunction) {
    const ipAddress = req.ip || req.socket.remoteAddress || '';
    const sessionId = crypto.createHash('sha256').update(ipAddress).digest('hex');

    // Always expose the session id for usage tracking downstream.
    res.locals.sessionId = sessionId;

    if (config.rateLimits.disabled) {
      return next();
    }

    const effectiveLimit = maxRequestsPerMinute || config.rateLimits.default;
    const { limited, retryAfter } = checkRateLimit(sessionId, effectiveLimit);

    if (limited) {
      logger.warn(`Rate limit exceeded for session: ${sessionId.substring(0, 8)}...`);

      res.setHeader('Retry-After', retryAfter.toString());
      res.status(429).json({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
        },
      });
      return;
    }

    next();
  };
}
