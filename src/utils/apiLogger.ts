import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import envPaths from 'env-paths';
import { randomUUID } from 'crypto';

const paths = envPaths('claude-cli');

// Helper function to get a sanitized project directory name
function getProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// Get the API logs directory
export const API_LOGS_PATH = join(paths.cache, getProjectDir(process.cwd()), 'api-logs');

// Ensure the API logs directory exists
export function ensureApiLogsDirectoryExists(): void {
  if (!existsSync(API_LOGS_PATH)) {
    mkdirSync(API_LOGS_PATH, { recursive: true });
  }
}

// Get the current date in YYYY-MM-DD format
export function getCurrentDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// Get the path for today's API log file
export function getApiLogFilePath(): string {
  ensureApiLogsDirectoryExists();
  return join(API_LOGS_PATH, `api-log-${getCurrentDate()}.jsonl`);
}

// Sanitize sensitive data in requests/responses
function sanitizeData(data: any): any {
  if (!data) return data;
  
  try {
    // Make a deep copy to avoid modifying the original
    const sanitized = JSON.parse(JSON.stringify(data));
    
    // Recursively sanitize objects
    const sanitizeObject = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      
      for (const key of Object.keys(obj)) {
        // Sanitize sensitive fields
        if (
          key === 'api_key' || 
          key === 'apiKey' || 
          key === 'authorization' || 
          key === 'Authorization' ||
          key === 'token' ||
          key === 'password' ||
          key === 'key'
        ) {
          obj[key] = '***REDACTED***';
        } 
        // Recursively sanitize nested objects
        else if (typeof obj[key] === 'object' && obj[key] !== null) {
          sanitizeObject(obj[key]);
        }
      }
    };
    
    sanitizeObject(sanitized);
    return sanitized;
  } catch (e) {
    // If we can't sanitize (e.g., circular references), return a simplified version
    return typeof data === 'object' ? { sanitized: '[Object could not be safely sanitized]' } : data;
  }
}

// Log an API request and response
export function logApiCall({
  url,
  method,
  headers,
  body,
  response,
  responseBody,
  statusCode,
  error,
  durationMs,
  service = 'unknown'
}: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: any;
  response?: Response;
  responseBody?: any;
  statusCode?: number;
  error?: any;
  durationMs: number;
  service?: string;
}): void {
  try {
    const logEntry = {
      timestamp: new Date().toISOString(),
      id: randomUUID(),
      service,
      url,
      method,
      headers: sanitizeData(headers),
      body: sanitizeData(body),
      responseHeaders: response ? Object.fromEntries([...response.headers.entries()]) : undefined,
      responseBody: responseBody ? sanitizeData(responseBody) : undefined,
      statusCode: statusCode || (response ? response.status : undefined),
      error: error ? (error instanceof Error ? { message: error.message, stack: error.stack } : error) : undefined,
      durationMs
    };

    const logPath = getApiLogFilePath();
    appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
  } catch (e) {
    console.error('Error writing API log:', e);
  }
}

// Create a global fetch wrapper that logs all API calls
const originalFetch = globalThis.fetch;

// Replace the global fetch with our logging version
globalThis.fetch = async function loggedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const request = new Request(input, init);
  const url = request.url;
  const method = request.method;
  const headers = Object.fromEntries([...request.headers.entries()]);
  
  let body;
  if (request.body) {
    try {
      // Try to clone the request to get the body
      const clonedRequest = request.clone();
      const text = await clonedRequest.text();
      body = text;
      
      // Try to parse as JSON if it looks like JSON
      if (text && (text.startsWith('{') || text.startsWith('['))) {
        body = JSON.parse(text);
      }
    } catch (e) {
      body = '[Could not read request body]';
    }
  }
  
  const startTime = Date.now();
  let responseBody;
  let response: Response | undefined;
  
  try {
    response = await originalFetch(request);
    const durationMs = Date.now() - startTime;
    
    // Clone the response to avoid consuming the body
    const clonedResponse = response.clone();
    
    // Try to get the response body
    try {
      const text = await clonedResponse.text();
      responseBody = text;
      
      // Try to parse as JSON if it looks like JSON
      if (text && (text.startsWith('{') || text.startsWith('['))) {
        responseBody = JSON.parse(text);
      }
    } catch (e) {
      responseBody = '[Could not read response body]';
    }
    
    // Log the successful API call
    logApiCall({
      url,
      method,
      headers,
      body,
      response,
      responseBody,
      durationMs,
      service: getServiceFromUrl(url)
    });
    
    return response;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    
    // Log the failed API call
    logApiCall({
      url,
      method,
      headers,
      body,
      response,
      error,
      durationMs,
      service: getServiceFromUrl(url)
    });
    
    throw error;
  }
};

// Helper to determine the service based on the URL
function getServiceFromUrl(url: string): string {
  const urlObj = new URL(url);
  const hostname = urlObj.hostname;
  
  if (hostname.includes('anthropic.com') || hostname.includes('claude')) {
    return 'anthropic';
  } else if (hostname.includes('openai.com') || hostname.includes('oai')) {
    return 'openai';
  } else if (hostname.includes('anthropic-bedrock')) {
    return 'anthropic-bedrock';
  } else if (hostname.includes('vertex-ai')) {
    return 'anthropic-vertex';
  } else if (hostname.includes('amazonaws.com')) {
    return 'aws';
  } else if (hostname.includes('google')) {
    return 'google';
  }
  
  return 'unknown';
}

// Export a function to enable API logging
export function enableApiLogging(): void {
  console.log('API logging enabled. Logs will be written to:', getApiLogFilePath());
  ensureApiLogsDirectoryExists();
}

// Function to get all API logs
export function getApiLogs(): string[] {
  try {
    ensureApiLogsDirectoryExists();
    const fs = require('fs');
    const path = require('path');
    
    return fs.readdirSync(API_LOGS_PATH)
      .filter((file: string) => file.startsWith('api-log-') && file.endsWith('.jsonl'))
      .sort((a: string, b: string) => {
        // Sort by date (newest first)
        const dateA = a.replace('api-log-', '').replace('.jsonl', '');
        const dateB = b.replace('api-log-', '').replace('.jsonl', '');
        return dateB.localeCompare(dateA);
      })
      .map((file: string) => path.join(API_LOGS_PATH, file));
  } catch (error) {
    console.error('Error getting API logs:', error);
    return [];
  }
}

// Higher-order function to wrap API functions with logging
export function withApiLogging<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  serviceName: string
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
  return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    const startTime = Date.now();
    let result;
    let error;
    
    try {
      result = await fn(...args);
      return result;
    } catch (e) {
      error = e;
      throw e;
    } finally {
      const endTime = Date.now();
      const durationMs = endTime - startTime;
      
      // Extract request details from args if possible
      const requestDetails = extractRequestDetails(args);
      
      // Extract response details if available
      const responseDetails = result ? extractResponseDetails(result) : undefined;
      
      // Log the API call
      logApiCall({
        url: requestDetails?.url || 'unknown',
        method: requestDetails?.method || 'unknown',
        headers: requestDetails?.headers,
        body: requestDetails?.body,
        response: responseDetails?.response,
        responseBody: responseDetails?.body,
        statusCode: responseDetails?.status,
        error,
        durationMs,
        service: serviceName
      });
    }
  };
}

// Helper function to extract request details from function arguments
function extractRequestDetails(args: any[]): { url?: string; method?: string; headers?: Record<string, string>; body?: any } | undefined {
  // Try to find URL and method in the arguments
  for (const arg of args) {
    if (arg && typeof arg === 'object') {
      // Check if it's a Request object
      if (arg instanceof Request) {
        return {
          url: arg.url,
          method: arg.method,
          headers: Object.fromEntries(arg.headers.entries()),
          body: arg.body
        };
      }
      
      // Check if it's an object with URL and method properties
      if (arg.url && arg.method) {
        return {
          url: arg.url,
          method: arg.method,
          headers: arg.headers,
          body: arg.body
        };
      }
    }
  }
  
  return undefined;
}

// Helper function to extract response details
function extractResponseDetails(result: any): { response?: Response; body?: any; status?: number } | undefined {
  if (!result) return undefined;
  
  // If it's a Response object
  if (result instanceof Response) {
    return {
      response: result,
      status: result.status
    };
  }
  
  // If it has a response property that is a Response
  if (result.response && result.response instanceof Response) {
    return {
      response: result.response,
      status: result.response.status,
      body: result.body
    };
  }
  
  // If it has status and data properties
  if (result.status !== undefined) {
    return {
      status: result.status,
      body: result.data || result.body
    };
  }
  
  return undefined;
} 