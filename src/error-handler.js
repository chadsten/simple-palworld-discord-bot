/**
 * Centralized error handling utilities for consistent error management
 * across the Palworld Discord bot
 */
import { sanitizeErrorMessage } from './utils/security.js';
import { createLogger } from './utils/logger.js';

/**
 * Standard error types for the application
 */
export class PalworldAPIError extends Error {
  constructor(message, statusCode, endpoint) {
    super(message);
    this.name = 'PalworldAPIError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
  }
}

export class ServerNotRunningError extends Error {
  constructor() {
    super('Palworld server is not running');
    this.name = 'ServerNotRunningError';
  }
}

export class AuthorizationError extends Error {
  constructor() {
    super('User not authorized for this operation');
    this.name = 'AuthorizationError';
  }
}

/**
 * Wraps API calls with consistent error handling and timeout
 * @param {Function} apiCall - The API function to wrap
 * @param {number} timeoutMs - Timeout in milliseconds (default: 10000)
 * @returns {Function} Wrapped API function with error handling
 */
export function withErrorHandling(apiCall, timeoutMs = 10000) {
  const logger = createLogger('ErrorHandler');
  
  return async (...args) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      
      try {
        const result = await apiCall(...args);
        clearTimeout(timeoutId);
        return result;
      } catch (error) {
        clearTimeout(timeoutId);
        
        if (error.name === 'AbortError') {
          throw new PalworldAPIError('API request timeout', 408, 'unknown');
        }
        
        // Sanitize error before re-throwing
        const sanitizedMessage = sanitizeErrorMessage(error);
        const sanitizedError = new Error(sanitizedMessage);
        sanitizedError.name = error.name;
        sanitizedError.statusCode = error.statusCode;
        sanitizedError.endpoint = error.endpoint;
        throw sanitizedError;
      }
    } catch (error) {
      // Log sanitized error details for debugging
      const sanitizedMessage = sanitizeErrorMessage(error);
      logger.error(`API Error: ${sanitizedMessage}`, {
        endpoint: error.endpoint ? '[ENDPOINT]' : undefined,
        statusCode: error.statusCode
      });
      
      // Always throw sanitized error
      const sanitizedError = new Error(sanitizedMessage);
      sanitizedError.name = error.name;
      sanitizedError.statusCode = error.statusCode;
      sanitizedError.endpoint = error.endpoint;
      throw sanitizedError;
    }
  };
}