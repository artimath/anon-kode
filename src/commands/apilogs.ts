import { Command } from '../commands'
import { API_LOGS_PATH, getApiLogs } from '../utils/apiLogger'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import chalk from 'chalk'

const apilogsCommand = {
  type: 'local',
  name: 'apilogs',
  description: 'View and manage API logs',
  isEnabled: true,
  isHidden: false,
  async call(args: string) {
    const [subcommand, ...params] = args.trim().split(' ').filter(Boolean)

    switch (subcommand) {
      case 'list':
        return await listLogFiles()
      case 'tail':
        const numLines = params[0] ? parseInt(params[0]) : 20
        return await tailLogs(numLines)
      case 'clear':
        return await clearLogs()
      case 'dir':
        return API_LOGS_PATH
      case 'view':
        if (!params[0]) {
          return 'Error: Please specify a log file to view'
        }
        const viewNumLines = params[1] ? parseInt(params[1]) : 0
        return await viewLogFile(params[0], viewNumLines)
      default:
        return `
API Logs Command

Usage:
  /apilogs list                 - List all available log files
  /apilogs tail [n]             - Show last n lines of most recent log (default: 20)
  /apilogs clear                - Clear all API logs (with confirmation)
  /apilogs dir                  - Show logs directory path
  /apilogs view <file> [n]      - View specific log file or last n lines
`
    }
  },
  userFacingName() {
    return 'apilogs'
  },
} satisfies Command

async function clearLogs(): Promise<string> {
  const logsDir = API_LOGS_PATH
  
  // Create readline interface for user input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  
  return new Promise((resolve) => {
    rl.question(chalk.yellow('Are you sure you want to clear all API logs? (y/N): '), (answer) => {
      rl.close()
      
      if (answer.toLowerCase() === 'y') {
        try {
          const files = fs.readdirSync(logsDir)
          let deletedCount = 0
          
          for (const file of files) {
            if (file.endsWith('.log') || file.endsWith('.jsonl')) {
              fs.unlinkSync(path.join(logsDir, file))
              deletedCount++
            }
          }
          
          resolve(chalk.green(`Successfully deleted ${deletedCount} log files`))
        } catch (error) {
          resolve(chalk.red(`Error clearing logs: ${error.message}`))
        }
      } else {
        resolve(chalk.yellow('Operation cancelled'))
      }
    })
  })
}

async function listLogFiles(): Promise<string> {
  const logsDir = API_LOGS_PATH
  
  try {
    const files = fs.readdirSync(logsDir)
      .filter(file => file.endsWith('.log') || file.endsWith('.jsonl'))
      .map(file => {
        const filePath = path.join(logsDir, file)
        const stats = fs.statSync(filePath)
        return {
          name: file,
          size: stats.size,
          created: stats.birthtime,
          path: filePath
        }
      })
      .sort((a, b) => b.created.getTime() - a.created.getTime())
    
    if (files.length === 0) {
      return chalk.yellow('No log files found')
    }
    
    let result = chalk.bold('API Log Files:\n\n')
    
    files.forEach((file, index) => {
      const sizeInKB = (file.size / 1024).toFixed(2)
      const date = file.created.toLocaleString()
      result += chalk.cyan(`${index + 1}. ${file.name}\n`)
      result += `   Size: ${sizeInKB} KB\n`
      result += `   Created: ${date}\n`
      result += `   Path: ${file.path}\n\n`
    })
    
    return result
  } catch (error) {
    return chalk.red(`Error listing log files: ${error.message}`)
  }
}

async function tailLogs(numLines: number = 20): Promise<string> {
  const logsDir = API_LOGS_PATH
  
  try {
    const files = fs.readdirSync(logsDir)
      .filter(file => file.endsWith('.log') || file.endsWith('.jsonl'))
      .map(file => {
        const filePath = path.join(logsDir, file)
        const stats = fs.statSync(filePath)
        return { name: file, created: stats.birthtime, path: filePath }
      })
      .sort((a, b) => b.created.getTime() - a.created.getTime())
    
    if (files.length === 0) {
      return chalk.yellow('No log files found')
    }
    
    const latestLog = files[0]
    return await viewLogFile(latestLog.path, numLines)
  } catch (error) {
    return chalk.red(`Error tailing logs: ${error.message}`)
  }
}

async function viewLogFile(fileNameOrPath: string, numLines: number = 0): Promise<string> {
  const logsDir = API_LOGS_PATH
  let filePath = fileNameOrPath
  
  // If the provided string doesn't look like a path, treat it as a filename
  if (!fileNameOrPath.includes(path.sep)) {
    filePath = path.join(logsDir, fileNameOrPath)
    // If no extension provided, add .jsonl as default
    if (!path.extname(filePath)) {
      filePath += '.jsonl'
    }
  }
  
  try {
    if (!fs.existsSync(filePath)) {
      return chalk.red(`Log file not found: ${filePath}`)
    }
    
    const fileContent = fs.readFileSync(filePath, 'utf8')
    const logEntries = fileContent.split('\n').filter(Boolean).map(line => {
      try {
        return JSON.parse(line)
      } catch (e) {
        return { raw: line }
      }
    })
    
    if (logEntries.length === 0) {
      return chalk.yellow('Log file is empty')
    }
    
    let result = chalk.bold(`Log File: ${path.basename(filePath)}\n\n`)
    
    // If numLines is specified, only show the last N lines
    const entriesToShow = numLines > 0 
      ? logEntries.slice(-numLines) 
      : logEntries
    
    entriesToShow.forEach(entry => {
      result += formatAndDisplayLogEntry(entry) + '\n\n'
    })
    
    return result
  } catch (error) {
    return chalk.red(`Error viewing log file: ${error.message}`)
  }
}

function formatAndDisplayLogEntry(entry: any): string {
  if (entry.raw) {
    return entry.raw
  }
  
  let result = ''
  
  // Timestamp
  if (entry.timestamp) {
    result += chalk.gray(`[${new Date(entry.timestamp).toLocaleString()}] `)
  }
  
  // Service name
  if (entry.service) {
    result += chalk.bold.blue(`${entry.service} `)
  }
  
  // Request details
  if (entry.request) {
    const method = entry.request.method || 'UNKNOWN'
    const url = entry.request.url || ''
    
    result += chalk.bold(`${getMethodColor(method)(method)} ${getUrlPath(url)}\n`)
    
    // Headers (optional)
    if (entry.request.headers && Object.keys(entry.request.headers).length > 0) {
      result += chalk.gray('  Headers: ')
      result += chalk.gray(JSON.stringify(entry.request.headers, null, 2).replace(/\n/g, '\n  ')) + '\n'
    }
    
    // Body (optional)
    if (entry.request.body) {
      result += chalk.gray('  Body: ')
      const body = typeof entry.request.body === 'string' 
        ? entry.request.body 
        : JSON.stringify(entry.request.body, null, 2)
      result += chalk.gray(body.replace(/\n/g, '\n  ')) + '\n'
    }
  }
  
  // Response details
  if (entry.response) {
    const status = entry.response.status || 0
    let statusColor = chalk.green
    
    if (status >= 400 && status < 500) {
      statusColor = chalk.yellow
    } else if (status >= 500) {
      statusColor = chalk.red
    }
    
    result += statusColor(`  Response: ${status}`)
    
    // Response time
    if (entry.responseTime) {
      result += chalk.gray(` (${entry.responseTime}ms)`)
    }
    
    result += '\n'
    
    // Response body (optional)
    if (entry.response.body) {
      result += chalk.gray('  Body: ')
      const body = typeof entry.response.body === 'string' 
        ? entry.response.body 
        : JSON.stringify(entry.response.body, null, 2)
      result += chalk.gray(body.replace(/\n/g, '\n  '))
    }
  }
  
  // Error details
  if (entry.error) {
    result += chalk.red(`  Error: ${entry.error.message || entry.error}\n`)
    if (entry.error.stack) {
      result += chalk.gray(`  Stack: ${entry.error.stack}`)
    }
  }
  
  return result
}

function getMethodColor(method: string): chalk.ChalkFunction {
  switch (method.toUpperCase()) {
    case 'GET':
      return chalk.green
    case 'POST':
      return chalk.blue
    case 'PUT':
      return chalk.yellow
    case 'DELETE':
      return chalk.red
    case 'PATCH':
      return chalk.magenta
    default:
      return chalk.white
  }
}

function getUrlPath(url: string): string {
  try {
    const urlObj = new URL(url)
    return `${urlObj.pathname}${urlObj.search}`
  } catch (e) {
    return url
  }
}

export default apilogsCommand 