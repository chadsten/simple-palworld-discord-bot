/**
 * Security utilities for input validation and sanitization
 * Prevents command injection and information disclosure vulnerabilities
 */

import { resolve, parse, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Validates Windows service names against strict whitelist criteria
 * Service names must contain only alphanumeric characters, hyphens, and underscores
 * @param {string} serviceName - The service name to validate
 * @returns {boolean} true if service name is valid, false otherwise
 * @throws {Error} If service name fails validation with specific reason
 */
export function validateServiceName(serviceName) {
  if (typeof serviceName !== 'string') {
    throw new Error('Service name must be a string');
  }
  
  if (serviceName.length === 0 || serviceName.length > 256) {
    throw new Error('Service name must be between 1 and 256 characters');
  }
  
  // Windows service names: alphanumeric, hyphens, underscores only
  const validPattern = /^[a-zA-Z0-9_-]+$/;
  if (!validPattern.test(serviceName)) {
    throw new Error('Service name contains invalid characters');
  }
  
  // Prevent reserved names and suspicious patterns
  const reservedNames = ['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'];
  if (reservedNames.includes(serviceName.toLowerCase())) {
    throw new Error('Service name uses reserved system name');
  }
  
  return true;
}

/**
 * Validates and parses start command to prevent command injection
 * Ensures executable exists and arguments are safely structured
 * @param {string} startCommand - The command string to validate
 * @returns {Object} Object with {executable: string, args: string[]} if valid
 * @throws {Error} If command fails validation with specific reason
 */
export function validateStartCommand(startCommand) {
  if (typeof startCommand !== 'string') {
    throw new Error('Start command must be a string');
  }
  
  if (startCommand.length === 0 || startCommand.length > 2048) {
    throw new Error('Start command must be between 1 and 2048 characters');
  }
  
  // Parse command into executable and arguments
  // Simple space-based parsing with quote support
  const parts = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  
  for (let i = 0; i < startCommand.length; i++) {
    const char = startCommand[i];
    
    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuotes) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  
  if (current.length > 0) {
    parts.push(current);
  }
  
  if (parts.length === 0) {
    throw new Error('Start command is empty after parsing');
  }
  
  const executable = parts[0];
  const args = parts.slice(1);
  
  // Validate executable path
  validateExecutablePath(executable);
  
  // Validate arguments don't contain dangerous patterns
  for (const arg of args) {
    validateCommandArgument(arg);
  }
  
  return { executable, args };
}

/**
 * Validates executable path for security and existence
 * @param {string} executablePath - Path to executable
 * @throws {Error} If path is invalid or dangerous
 */
function validateExecutablePath(executablePath) {
  if (typeof executablePath !== 'string') {
    throw new Error('Executable path must be a string');
  }
  
  if (executablePath.length === 0 || executablePath.length > 260) {
    throw new Error('Executable path must be between 1 and 260 characters');
  }
  
  // Prevent dangerous characters and patterns
  const dangerousPatterns = [
    /[<>"|*?]/,           // Windows dangerous chars
    /\.\./,               // Directory traversal
    /[;&|`$()]/,          // Shell injection chars
    /\b(cmd|powershell|bash|sh)\b|\/bin\/(sh|bash)/i,  // Shell executables
    /\s*(-|\/)(c|command|exec)\s+/i,       // Shell command flags
  ];
  
  for (const pattern of dangerousPatterns) {
    if (pattern.test(executablePath)) {
      throw new Error('Executable path contains dangerous characters or patterns');
    }
  }
  
  // Normalize and validate path
  let normalizedPath;
  try {
    normalizedPath = isAbsolute(executablePath) ? resolve(executablePath) : executablePath;
  } catch {
    throw new Error('Executable path cannot be normalized');
  }
  
  // For relative paths, only allow simple filenames
  if (!isAbsolute(executablePath)) {
    const parsed = parse(executablePath);
    if (parsed.dir) {
      throw new Error('Relative executable path cannot contain directory components');
    }
  }
  
  // Check if executable exists (for absolute paths)
  if (isAbsolute(normalizedPath) && !existsSync(normalizedPath)) {
    throw new Error('Executable file does not exist');
  }
}

/**
 * Validates individual command arguments
 * @param {string} arg - Command argument to validate
 * @throws {Error} If argument contains dangerous patterns
 */
function validateCommandArgument(arg) {
  if (typeof arg !== 'string') {
    throw new Error('Command argument must be a string');
  }
  
  if (arg.length > 1024) {
    throw new Error('Command argument too long');
  }
  
  // Prevent shell injection patterns in arguments
  const dangerousPatterns = [
    /[;&|`$()]/,          // Shell metacharacters
    /\s*(-|\/)(c|command|exec)\s+/i,  // Command execution flags
    /\$\{.*\}/,           // Variable expansion
    /`.*`/,               // Command substitution
    /\$\(.*\)/,           // Command substitution
  ];
  
  for (const pattern of dangerousPatterns) {
    if (pattern.test(arg)) {
      throw new Error('Command argument contains dangerous patterns');
    }
  }
}

/**
 * Sanitizes error messages to prevent information disclosure
 * Removes file paths, credentials, and other sensitive information
 * @param {Error|string} error - Error object or message to sanitize
 * @param {boolean} includeType - Whether to include error type in output
 * @returns {string} Sanitized error message safe for user display
 */
export function sanitizeErrorMessage(error, includeType = false) {
  let message = error instanceof Error ? error.message : String(error);
  
  // Remove file system paths (Windows and Unix style)
  message = message.replace(/[A-Za-z]:\\[^\s<>"|?*\n\r]+/g, '[PATH_REMOVED]');
  message = message.replace(/\/[^\s<>"|?*\n\r]+/g, '[PATH_REMOVED]');
  
  // Remove potential credentials (basic patterns)
  message = message.replace(/password[=:]\s*[^\s\n\r]+/gi, 'password=[REDACTED]');
  message = message.replace(/token[=:]\s*[^\s\n\r]+/gi, 'token=[REDACTED]');
  message = message.replace(/key[=:]\s*[^\s\n\r]+/gi, 'key=[REDACTED]');
  message = message.replace(/auth[=:]\s*[^\s\n\r]+/gi, 'auth=[REDACTED]');
  
  // Remove environment variable values
  message = message.replace(/\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^\s\n\r]+/g, '$1=[REDACTED]');
  message = message.replace(/%[A-Za-z_][A-Za-z0-9_]*%/g, '[ENV_VAR]');
  
  // Remove IP addresses and ports
  message = message.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[IP_ADDRESS]');
  
  // Remove URLs with credentials
  message = message.replace(/https?:\/\/[^@\s]+:[^@\s]+@[^\s]+/g, '[URL_WITH_CREDENTIALS]');
  
  // Remove Windows service names from error context (to prevent enumeration)
  message = message.replace(/service\s+['"]([^'"]+)['"]/gi, 'service [SERVICE_NAME]');
  
  // Generic cleanup
  message = message.replace(/\s+/g, ' ').trim();
  
  // Standardize common error messages
  const sanitizedPatterns = [
    { pattern: /cannot find .* file/i, replacement: 'Required file not found' },
    { pattern: /access.* denied/i, replacement: 'Access denied' },
    { pattern: /permission.* denied/i, replacement: 'Permission denied' },
    { pattern: /network.* unreachable/i, replacement: 'Network connection failed' },
    { pattern: /connection.* refused/i, replacement: 'Connection refused' },
    { pattern: /timeout.* occurred/i, replacement: 'Operation timeout' },
  ];
  
  for (const { pattern, replacement } of sanitizedPatterns) {
    if (pattern.test(message)) {
      message = replacement;
      break;
    }
  }
  
  // Include error type if requested and it's an Error object
  if (includeType && error instanceof Error && error.name !== 'Error') {
    return `${error.name}: ${message}`;
  }
  
  return message;
}

/**
 * Creates a secure wrapper for environment variable access
 * Validates and sanitizes environment variables before use
 * @param {string} varName - Environment variable name
 * @param {Function} validator - Validation function for the value
 * @param {*} defaultValue - Default value if variable is not set
 * @returns {*} Validated environment variable value or default
 * @throws {Error} If validation fails
 */
export function getSecureEnvVar(varName, validator, defaultValue = undefined) {
  if (typeof varName !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(varName)) {
    throw new Error('Invalid environment variable name');
  }
  
  const value = process.env[varName];
  
  if (value === undefined || value === '') {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Required environment variable ${varName} is not set`);
  }
  
  if (typeof validator === 'function') {
    try {
      validator(value);
    } catch (error) {
      throw new Error(`Environment variable ${varName} validation failed: ${sanitizeErrorMessage(error)}`);
    }
  }
  
  return value;
}