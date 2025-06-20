#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import { z } from 'zod';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import fetch from 'node-fetch';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as toml from '@iarna/toml';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// --- Configuration ---
const DEFAULT_PORT = 6181;
const DEFAULT_API_URL = 'https://mcpfinder.dev';

// --- Global state for server/transport ---
let runningHttpServer = null;
let httpTransportInstance = null;
let serverInstance = null;

// Store API URL globally for tool implementations
let globalApiUrl = DEFAULT_API_URL;

// --- Help Text ---
const helpText = `
MCPfinder

Manages local MCP configurations for clients like Cursor and Claude.
Communicates with the MCPFinder Registry API (https://mcpfinder.dev/api).

Available as both stdio and HTTP/SSE transport variants:
- Stdio transport: For direct integration with local AI clients
- HTTP/SSE transport: For web-accessible deployment (SSE endpoint available at https://mcpfinder.dev/mcp)

Local usage: node index.js [options] [command]

Commands:
  (no command)      Run the server (default: stdio transport)
  install           For users and AI clients: Run the interactive setup to configure a client
  register          For server publishers: Register your MCP server package with the MCPFinder registry (beta)
  scrape            Run automated scraping to discover new MCP servers (use --once for single run)
  schedule-scraper  Start the daily scraper scheduler

Options (for running the server):
  --http            Run the server locally in HTTP mode with SSE support. Default is stdio transport.
  --port <number>   Port for HTTP mode (overrides MCP_PORT env var). Default: ${DEFAULT_PORT}
  --api-url <url>   URL of the MCP Finder Registry API (overrides MCPFINDER_API_URL env var). Default: ${DEFAULT_API_URL}
  --help            Display this help message.

Transport Options:
  Stdio (default)   Direct JSON-RPC communication for local AI clients
  HTTP with SSE     Web-accessible endpoint supporting both HTTP and Server-Sent Events

Environment Variables:
  MCP_PORT           Port for HTTP mode (default: ${DEFAULT_PORT}).
  MCPFINDER_API_URL  URL of the MCP Finder Registry API (default: ${DEFAULT_API_URL}).
`;

// --- Argument Parsing ---
const args = process.argv.slice(2);
const runHttp = args.includes('--http');
const showHelp = args.includes('--help');

// Parse for commands with their aliases
const isSetupCommand = args.includes('setup') || args.includes('install') || args.includes('init');
const isRegisterCommand = args.includes('register');
const isScrapeCommand = args.includes('scrape');
const isScheduleScraperCommand = args.includes('schedule-scraper');

// Define known flags and commands
const knownFlags = ['--help', '--http', '--port', '--api-url', '--headless', '--description', '--tags', '--auth-token', '--requires-api-key', '--auth-type', '--key-name', '--auth-instructions', '--once', '--confirm'];
const knownCommands = ['setup', 'install', 'init', 'register', 'scrape', 'schedule-scraper'];

// Check for unknown commands
const hasUnknownCommand = (() => {
  let foundCommand = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Skip flags and their values
    if (knownFlags.includes(arg)) {
      // If this is a flag that takes a value, skip the next argument
      if (arg === '--port' || arg === '--api-url' || arg === '--description' || arg === '--tags' || arg === '--auth-token' || arg === '--auth-type' || arg === '--key-name' || arg === '--auth-instructions' || arg === '--confirm') {
        i++;
      }
      continue;
    }
    // If it's a known command, it's valid
    if (knownCommands.includes(arg)) {
      foundCommand = true;
      continue;
    }
    // If we found a command already, this might be a command argument
    if (foundCommand) {
      continue;
    }
    // Otherwise, it's an unknown command
    return true;
  }
  return false;
})();

function getArgValue(argName) {
    const index = args.indexOf(argName);
    if (index !== -1 && index + 1 < args.length) {
        return args[index + 1];
    }
    return null;
}

const cliPort = getArgValue('--port');
const cliApiUrl = getArgValue('--api-url');

// --- Tool Schemas (Zod for internal validation) ---
const SearchServersInput = z.object({
  query: z.string().optional().describe("Keywords to search for in tool name or description."),
  tag: z.string().optional().describe("Specific tag to filter by."),
});

const GetServerDetailsInput = z.object({
  id: z.string().min(1).describe("The unique ID of the MCP server."),
});

// Union schema to ensure either client_type or config_file_path is provided, but not both.
const ClientIdentifierSchema = z.union([
  z.object({
    client_type: z.string().describe("The type or name of the client application (e.g., 'cursor', 'claude', 'windsurf', 'claude-code', 'codex')."),
    config_file_path: z.undefined(),
  }),
  z.object({
    client_type: z.undefined(),
    config_file_path: z.string().describe("Absolute path or path starting with '~' to the MCP JSON configuration file."),
  })
], {
  errorMap: (issue, ctx) => {
    if (issue.code === z.ZodIssueCode.invalid_union) {
        if (ctx.data?.client_type !== undefined && ctx.data?.config_file_path !== undefined) {
            return { message: "Invalid input: Provide either 'client_type' OR 'config_file_path', but not both." };
        }
        return { message: "Invalid input: Provide either 'client_type' OR 'config_file_path'." };
    }
    return { message: ctx.defaultError };
  }
}).describe("Specify the target configuration either by client_type (for known clients) or config_file_path.");

const AddServerConfigInput = z.object({
  server_id: z.string().describe("A unique identifier for the server configuration entry."),
  mcp_definition: z.object({
    command: z.array(z.string()).optional().describe("The command and arguments to run the server. If omitted when env/workingDir provided, defaults will be fetched."),
    env: z.record(z.string()).optional().describe("Environment variables required by the server."),
    workingDirectory: z.string().optional().describe("The working directory for the server."),
  }).describe("The MCP server definition object. Optional.").optional(),
  claude_path: z.string().optional().describe("Full path to claude executable (only used for claude-code client_type when claude command is not in PATH)."),
}).and(ClientIdentifierSchema);

const RemoveServerConfigInput = z.object({
  server_id: z.string().describe("The unique identifier of the server configuration entry to remove."),
  claude_path: z.string().optional().describe("Full path to claude executable (only used for claude-code client_type when claude command is not in PATH)."),
}).and(ClientIdentifierSchema);

const StreamMcpEventsInput = z.object({
  duration: z.number().optional().describe("Duration in seconds to stream events (default: 30, max: 120)."),
  filter: z.array(z.string()).optional().describe("Event types to filter: tool.registered, tool.updated, tool.status_changed."),
  since: z.string().optional().describe("ISO timestamp to get events from (default: 1 hour ago)."),
});

// --- Tool Implementations ---

async function search_mcp_servers(input) {
  // Use globalApiUrl
  const searchUrl = new URL(`${globalApiUrl}/api/v1/search`);
  if (input.query) {
    searchUrl.searchParams.append('q', input.query);
  }
  if (input.tag) {
    searchUrl.searchParams.append('tag', input.tag);
  }
  console.error(`[search_mcp_servers] Fetching: ${searchUrl.toString()}`);
  try {
    const response = await fetch(searchUrl.toString());
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[search_mcp_servers] API Error (${response.status}): ${errorText}`);
      throw new Error(`Failed to fetch from MCP Finder API: ${response.statusText}`);
    }
    const data = await response.json();
    const formattedContent = data.map(server => ({
      type: 'text',
      text: `ID: ${server.id}\\nName: ${server.name}\\nDescription: ${server.description}\\nURL: ${server.url}\\nTags: ${Array.isArray(server.tags) ? server.tags.join(', ') : 'N/A'}`
    }));

    const instructionBlock = {
      type: 'text',
      text: "Use the 'add_mcp_server_config' tool with one of the listed server IDs to add it to the client's configuration."
    };

    return { content: [...formattedContent, instructionBlock] };

  } catch (error) {
    console.error('[search_mcp_servers] Error:', error);
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
}

async function get_mcp_server_details(input) {
  // Use globalApiUrl
  const url = `${globalApiUrl}/api/v1/tools/${input.id}`;
  console.error(`[get_mcp_server_details] Fetching: ${url}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
        if (response.status === 404) {
            throw new Error(`Server with ID ${input.id} not found.`);
        }
        const errorText = await response.text();
        console.error(`[get_mcp_server_details] API Error (${response.status}): ${errorText}`);
        throw new Error(`Failed to get MCP server details: ${response.statusText}`);
    }
    const manifest = await response.json();
    let installationDetails = {
        command: [], env: {}, workingDirectory: undefined,
    };
    let hintConstructionError = null;
    // Attempt to generate installation hints
    try {
        if (manifest.url && (manifest.url.startsWith('http://') || manifest.url.startsWith('https://'))) {
             // HTTP/SSE server - use mcp-remote wrapper
             installationDetails.command = ['npx', 'mcp-remote', manifest.url];
        } else if (manifest.url && !manifest.url.startsWith('http://') && !manifest.url.startsWith('https://')) {
             // NPM package
             installationDetails.command = ['npx', '-y', manifest.url];
        }
        if (manifest.auth && manifest.auth.type === 'api-key') {
            const envVarName = `${manifest.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_API_KEY`;
            installationDetails.env[envVarName] = `YOUR_${envVarName}`;
        }
    } catch (e) {
        console.error("[get_mcp_server_details] Error constructing installation hint:", e);
        hintConstructionError = `Failed to generate installation hint: ${e.message}`;
        installationDetails = { command: [], env: {}, workingDirectory: undefined }; // Reset on error
    }
    const details = { ...manifest, installation: installationDetails };
    const detailsBlock = { type: 'text', text: JSON.stringify(details, null, 2) };

    const instructionBlock = {
      type: 'text',
      text: `You can use the 'add_mcp_server_config' tool with server_id '${input.id}' to add this server. Optionally provide command/env/workingDirectory.`
    };

    const errorBlock = hintConstructionError
        ? { type: 'text', text: `Warning: ${hintConstructionError}` }
        : null;

    return {
      content: [detailsBlock, instructionBlock, errorBlock].filter(Boolean)
    };

  } catch (error) {
      console.error('[get_mcp_server_details] Error:', error);
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
}

// --- File Utils ---

async function checkClaudeCommandAvailable(claudePath = 'claude') {
  try {
    const execAsync = promisify(exec);
    await execAsync(`${claudePath} --version`);
    return { available: true, claudePath };
  } catch (error) {
    return { 
      available: false, 
      error: error.message,
      claudePath 
    };
  }
}

async function addMcpServerClaudeCode(server_id, mcp_definition, claudePath) {
  // Check if claude command is available
  const claudeCheck = await checkClaudeCommandAvailable(claudePath);
  if (!claudeCheck.available) {
    const errorMessage = claudePath 
      ? `Error: Claude CLI command not found at provided path: ${claudePath}\n\nPlease verify the path is correct and the claude executable is accessible.\n\nError details: ${claudeCheck.error}`
      : `Error: Claude CLI command not found in PATH. Please install Claude Code CLI or provide the full path to the claude executable using the 'claude_path' parameter.\n\nInstall Claude Code CLI: npm install -g @anthropic-ai/claude-code\n\nAlternatively, you can use 'claude' client_type for Claude Desktop instead.\n\nError details: ${claudeCheck.error}`;
    
    return { 
      content: [{ 
        type: 'text', 
        text: errorMessage
      }], 
      isError: true 
    };
  }

  // Fetch manifest to get the URL/package name
  let manifest;
  try {
    console.error(`[addMcpServerClaudeCode] Fetching manifest for ${server_id}.`);
    const detailsUrl = `${globalApiUrl}/api/v1/tools/${server_id}`;
    const response = await fetch(detailsUrl);
    if (!response.ok) throw new Error(`API error (${response.status}) fetching manifest for ${server_id}`);
    manifest = await response.json();
  } catch (fetchError) {
    console.error(`[addMcpServerClaudeCode] Failed to fetch manifest for ${server_id}:`, fetchError);
    return { content: [{ type: 'text', text: `Error: Failed to fetch manifest for server ${server_id}. ${fetchError.message}` }], isError: true };
  }

  // Generate a config key name for Claude Code
  const configKey = generateConfigKey(manifest.url, server_id);
  
  // Determine what to add - URL for HTTP/HTTPS servers, package name for NPM packages
  let addTarget;
  if (manifest.url && (manifest.url.startsWith('http://') || manifest.url.startsWith('https://'))) {
    addTarget = manifest.url;
    console.error(`[addMcpServerClaudeCode] HTTP/SSE server detected, will add URL: ${addTarget}`);
  } else if (manifest.url && !manifest.url.startsWith('http://') && !manifest.url.startsWith('https://')) {
    addTarget = manifest.url;
    console.error(`[addMcpServerClaudeCode] NPM package detected, will add package: ${addTarget}`);
  } else {
    return { content: [{ type: 'text', text: `Error: Could not determine package name or URL for server ${server_id}` }], isError: true };
  }

  // Execute claude mcp add command
  try {
    const execAsync = promisify(exec);
    
    const claudeCmd = claudeCheck.claudePath;
    const command = `${claudeCmd} mcp add ${configKey} ${addTarget}`;
    console.error(`[addMcpServerClaudeCode] Executing: ${command}`);
    
    const { stdout, stderr } = await execAsync(command);
    
    if (stderr && !stderr.includes('warning')) {
      console.error(`[addMcpServerClaudeCode] Command stderr: ${stderr}`);
      return { content: [{ type: 'text', text: `Error executing claude mcp add: ${stderr}` }], isError: true };
    }
    
    console.error(`[addMcpServerClaudeCode] Command stdout: ${stdout}`);
    return { content: [{ type: 'text', text: `Successfully added server '${server_id}' (as '${configKey}') to Claude Code using: ${command}` }] };
    
  } catch (execError) {
    console.error(`[addMcpServerClaudeCode] Failed to execute claude mcp add:`, execError);
    return { content: [{ type: 'text', text: `Error: Failed to execute claude mcp add command. Make sure Claude Code CLI is installed and accessible. ${execError.message}` }], isError: true };
  }
}

async function resolveAndValidateConfigPath(client_type, config_file_path) {
  let resolvedPath;
  if (config_file_path) {
    let rawPath = config_file_path;
    if (rawPath.startsWith('~')) {
      rawPath = path.join(os.homedir(), rawPath.slice(1));
    }
    if (!path.isAbsolute(rawPath)) {
      throw new Error(`Provided 'config_file_path' must be absolute or start with '~': ${config_file_path}`);
    }
    resolvedPath = rawPath;
    console.error(`[resolveAndValidateConfigPath] Using resolved path: ${resolvedPath}`);
  } else if (client_type) {
    resolvedPath = await getConfigPath(client_type);
    console.error(`[resolveAndValidateConfigPath] Resolved path for client '${client_type}': ${resolvedPath}`);
  } else {
    // Should be caught by Zod schema, but safeguard anyway
    throw new Error("Invalid state: Neither 'client_type' nor 'config_file_path' was provided.");
  }
  return resolvedPath;
}

async function getConfigPath(clientType) {
    const homeDir = os.homedir();
    switch (clientType) {
        case 'cursor':
            return path.join(homeDir, '.cursor', 'mcp.json');
        case 'claude':
            if (process.platform === 'darwin') {
                 return path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
            } else if (process.platform === 'win32') {
                 return path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
            } else { // Linux/Other
                return path.join(homeDir, '.config', 'Claude', 'claude_desktop_config.json');
            }
        case 'windsurf':
             return path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json');
        case 'codex':
             return path.join(homeDir, '.codex', 'config.toml');
        default:
            throw new Error(`Unsupported client type for automatic path resolution: '${clientType}'. Please provide 'config_file_path'.`);
    }
}

// Helper function to generate a short, sanitized key for the config file
function generateConfigKey(url, fallbackId) {
    const MAX_KEY_LENGTH = 16;

    // Fallback if URL is missing
    if (!url || typeof url !== 'string' || url.trim() === '') {
        console.warn(`[generateConfigKey] URL is empty, using fallback ID: ${fallbackId}`);
        return fallbackId.substring(0, MAX_KEY_LENGTH);
    }

    let key = url.trim();
    key = key.replace(/^https?:\/\//, '');
    key = key.toLowerCase();
    key = key.replace(/[^a-z0-9_]+/g, '_');
    key = key.replace(/^_+|_+$/g, '');

    if (key.length > MAX_KEY_LENGTH) {
        key = key.substring(0, MAX_KEY_LENGTH);
        key = key.replace(/_+$/g, '');
    }

    if (key === '') {
        console.warn(`[generateConfigKey] Sanitization resulted in empty key for URL "${url}", using fallback ID: ${fallbackId}`);
        return fallbackId.substring(0, MAX_KEY_LENGTH);
    }

    console.error(`[generateConfigKey] Generated key "${key}" for URL "${url}"`);
    return key;
}

// Returns default { mcpServers: {} } if file not found, throws for other errors.
async function readConfigFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        try {
            return JSON.parse(data);
        } catch (parseError) {
            console.error(`[readConfigFile] Error parsing JSON from ${filePath}:`, parseError);
            throw new Error(`Failed to parse JSON configuration file: ${filePath}.`);
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
             console.warn(`[readConfigFile] Config file not found at ${filePath}, treating as empty.`);
             return { mcpServers: {} };
        }
        console.error(`[readConfigFile] Error reading ${filePath}:`, error);
        throw new Error(`Failed to read config file: ${error.message}`);
    }
}

async function writeConfigFile(filePath, config) {
    try {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
        console.error(`[writeConfigFile] Successfully wrote config to ${filePath}`);
    } catch (error) {
        console.error(`[writeConfigFile] Error writing to ${filePath}:`, error);
        throw new Error(`Failed to write config file: ${error.message}`);
    }
}

// TOML-specific functions for Codex
async function readTomlConfigFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        try {
            return toml.parse(data);
        } catch (parseError) {
            console.error(`[readTomlConfigFile] Error parsing TOML from ${filePath}:`, parseError);
            throw new Error(`Failed to parse TOML configuration file: ${filePath}.`);
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
             console.warn(`[readTomlConfigFile] Config file not found at ${filePath}, treating as empty.`);
             return { mcp_servers: {} };
        }
        console.error(`[readTomlConfigFile] Error reading ${filePath}:`, error);
        throw new Error(`Failed to read config file: ${error.message}`);
    }
}

async function writeTomlConfigFile(filePath, config) {
    try {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        const tomlString = toml.stringify(config);
        await fs.writeFile(filePath, tomlString, 'utf-8');
        console.error(`[writeTomlConfigFile] Successfully wrote TOML config to ${filePath}`);
    } catch (error) {
        console.error(`[writeTomlConfigFile] Error writing to ${filePath}:`, error);
        throw new Error(`Failed to write TOML config file: ${error.message}`);
    }
}

async function add_mcp_server_config(input) {
  // Use globalApiUrl for fetching defaults
  const { server_id, client_type, config_file_path, mcp_definition } = input;

  // Special handling for Claude Code - use native claude mcp add command
  if (client_type === 'claude-code') {
    return await addMcpServerClaudeCode(server_id, mcp_definition, input.claude_path);
  }

  let resolvedPath;
  try {
      resolvedPath = await resolveAndValidateConfigPath(client_type, config_file_path);
      if (!resolvedPath) throw new Error('Failed to determine config file path.'); 
  } catch (error) {
      console.error(`[add_mcp_server_config] Error resolving path: ${error.message}`);
      return { content: [{ type: 'text', text: `Error resolving config path: ${error.message}` }], isError: true };
  }

  let finalDefinition = mcp_definition || {};

  // Fetch manifest FIRST to get URL for key generation
  let manifest;
  try {
    console.error(`[add_mcp_server_config] Fetching manifest for ${server_id} to generate config key.`);
    const detailsUrl = `${globalApiUrl}/api/v1/tools/${server_id}`;
    const response = await fetch(detailsUrl);
    if (!response.ok) throw new Error(`API error (${response.status}) fetching manifest for ${server_id}`);
    manifest = await response.json();
  } catch (fetchError) {
    console.error(`[add_mcp_server_config] Failed to fetch manifest for ${server_id}:`, fetchError);
    return { content: [{ type: 'text', text: `Error: Failed to fetch manifest required for configuration key for server ${server_id}. ${fetchError.message}` }], isError: true };
  }

  // Generate the key to use in the config file using the fetched manifest URL
  const configKey = generateConfigKey(manifest.url, server_id);

  // If definition is missing, or command is missing, fetch defaults from the API.
  if (!finalDefinition.command || finalDefinition.command.length === 0) {
    console.error(`[add_mcp_server_config] User did not provide command, determining from manifest...`);
    // Fetching is already done above, manifest variable is available
    try {
      let commandToUse = [];

      // First priority: Check if API provides a command
      if (manifest?.installation?.command && Array.isArray(manifest.installation.command) && manifest.installation.command.length > 0) {
        commandToUse = manifest.installation.command;
        console.error(`[add_mcp_server_config] Using command from fetched manifest installation: ${JSON.stringify(commandToUse)}`);
      } else {
        // Second priority: Generate command based on URL if no API command provided
        if (manifest.url && manifest.url.includes('github.com/')) {
          // GitHub repos can't be installed automatically
          console.error(`[add_mcp_server_config] GitHub repository detected, cannot auto-install`);
          return { 
            content: [{ 
              type: 'text', 
              text: `Error: GitHub repositories cannot be installed automatically.\n\nThis server (${manifest.url}) needs to be cloned and installed manually:\n1. Clone the repository: git clone ${manifest.url}\n2. Follow the installation instructions in the repository\n3. Configure the server manually in your MCP client\n\nFor more information, visit the repository.`
            }], 
            isError: true 
          };
        } else if (manifest.url && (manifest.url.startsWith('http://') || manifest.url.startsWith('https://'))) {
          commandToUse = ['npx', 'mcp-remote', manifest.url];
          console.error(`[add_mcp_server_config] HTTP/SSE server detected, using mcp-remote wrapper: ${JSON.stringify(commandToUse)}`);
        } else if (manifest.url && !manifest.url.startsWith('http://') && !manifest.url.startsWith('https://')) {
          // NPM package - use standard npx -y approach
          commandToUse = ['npx', '-y', manifest.url];
          console.error(`[add_mcp_server_config] NPM package detected: ${JSON.stringify(commandToUse)}`);
        } else {
          console.warn(`[add_mcp_server_config] Could not determine default command for ${server_id} from manifest URL.`);
        }
      }

      // Merge command with potentially provided env/workingDir
      finalDefinition = {
        command: commandToUse, // Use the determined command array
        env: mcp_definition?.env ?? (manifest?.installation?.env ?? {}),
        workingDirectory: mcp_definition?.workingDirectory ?? manifest?.installation?.workingDirectory
      };
      console.error(`[add_mcp_server_config] Using determined definition: ${JSON.stringify(finalDefinition)}`);

    } catch (fetchError) {
      console.error(`[add_mcp_server_config] Failed to fetch default definition for ${server_id}:`, fetchError);
      return { content: [{ type: 'text', text: `Error: Failed to fetch default configuration for server ${server_id}. ${fetchError.message}` }], isError: true };
    }
  }

  // If command is still missing after attempting fetch, return error
  if (!finalDefinition.command || finalDefinition.command.length === 0) {
      console.error(`[add_mcp_server_config] Command is still missing for ${server_id}.`);
      return { content: [{ type: 'text', text: `Error: Could not determine command for server ${server_id}. Provide in 'mcp_definition'.` }], isError: true };
  }

  // Format command array into command and args format for client config files
  if (Array.isArray(finalDefinition.command) && finalDefinition.command.length > 0) {
    const commandArray = finalDefinition.command;
    finalDefinition.command = commandArray[0]; // First element is the command
    if (commandArray.length > 1) {
      finalDefinition.args = commandArray.slice(1); // Rest are args
    }
    console.error(`[add_mcp_server_config] Formatted command: "${finalDefinition.command}" with args: ${JSON.stringify(finalDefinition.args || [])}`);
  }

  try {
    // Handle TOML files (Codex) differently
    const isTomlFile = resolvedPath.endsWith('.toml');
    let config;
    
    if (isTomlFile) {
      config = await readTomlConfigFile(resolvedPath);
      // For TOML, use 'mcp_servers' as the key (Codex requirement)
      if (!config.mcp_servers) {
        config.mcp_servers = {};
      }
      // Add or update the server entry using the generated key
      config.mcp_servers[configKey] = finalDefinition;
      await writeTomlConfigFile(resolvedPath, config);
    } else {
      config = await readConfigFile(resolvedPath);
      // Determine which key to use for server entries: prefer 'mcpServers', else 'servers'
      const serversKey = config.hasOwnProperty('mcpServers')
          ? 'mcpServers'
          : (config.hasOwnProperty('servers') ? 'servers' : 'mcpServers');
      if (!config[serversKey]) {
          config[serversKey] = {};
      }
      // Add or update the server entry using the generated key
      config[serversKey][configKey] = finalDefinition;
      await writeConfigFile(resolvedPath, config);
    }

    let successMessage = `Successfully added/updated server '${server_id}' (using config key name: '${configKey}') in ${resolvedPath}.`;
    if (client_type === 'claude' || config_file_path) {
      successMessage += ' You may need to restart the client application for changes to take effect.';
    }

    return { content: [{ type: 'text', text: successMessage }] };

  } catch (error) {
    console.error('[add_mcp_server_config] Error:', error);
    return { content: [{ type: 'text', text: `Error adding/updating server config: ${error.message}` }], isError: true };
  }
}

async function stream_mcp_events(input) {
  const duration = Math.min(input.duration || 30, 120) * 1000; // Convert to ms, max 2 minutes
  const filter = input.filter || [];
  const since = input.since || new Date(Date.now() - 3600000).toISOString();
  
  const eventUrl = new URL(`${globalApiUrl}/api/v1/events`);
  if (filter.length > 0) {
    eventUrl.searchParams.set('filter', filter.join(','));
  }
  eventUrl.searchParams.set('since', since);
  
  console.error(`[stream_mcp_events] Connecting to SSE: ${eventUrl.toString()}`);
  
  const events = [];
  const startTime = Date.now();
  
  return new Promise((resolve, reject) => {
    // Import EventSource dynamically
    import('eventsource').then(({ default: EventSource }) => {
      const eventSource = new EventSource(eventUrl.toString());
      
      const cleanup = () => {
        eventSource.close();
      };
      
      // Set timeout for duration
      const timeout = setTimeout(() => {
        cleanup();
        const summary = `Monitored events for ${Math.floor((Date.now() - startTime) / 1000)} seconds.\nReceived ${events.length} events.\n\nLatest events:\n` +
          events.slice(-5).map(e => `- ${e.timestamp}: ${e.type} - ${e.data.name}`).join('\n');
        resolve({ content: [{ type: 'text', text: summary }] });
      }, duration);
      
      eventSource.onopen = () => {
        console.error('[stream_mcp_events] SSE connection opened');
      };
      
      eventSource.onerror = (error) => {
        console.error('[stream_mcp_events] SSE error:', error);
        clearTimeout(timeout);
        cleanup();
        reject({ content: [{ type: 'text', text: `Error streaming events: ${error.message || 'Connection failed'}` }], isError: true });
      };
      
      // Handle specific event types
      const eventTypes = ['tool.registered', 'tool.updated', 'tool.status_changed', 'tool.health_checked'];
      eventTypes.forEach(eventType => {
        eventSource.addEventListener(eventType, (event) => {
          try {
            const data = JSON.parse(event.data);
            if (filter.length === 0 || filter.includes(eventType)) {
              events.push(data);
              console.error(`[stream_mcp_events] Received ${eventType} event:`, data.data.name);
            }
          } catch (e) {
            console.error(`[stream_mcp_events] Error parsing event data:`, e);
          }
        });
      });
      
      // Handle connection close
      eventSource.addEventListener('close', (event) => {
        console.error('[stream_mcp_events] Server closed connection');
        clearTimeout(timeout);
        cleanup();
        const summary = `Connection closed by server.\nMonitored for ${Math.floor((Date.now() - startTime) / 1000)} seconds.\nReceived ${events.length} events.\n\nLatest events:\n` +
          events.slice(-5).map(e => `- ${e.timestamp}: ${e.type} - ${e.data.name}`).join('\n');
        resolve({ content: [{ type: 'text', text: summary }] });
      });
    }).catch(importError => {
      console.error('[stream_mcp_events] Failed to import EventSource:', importError);
      // Fallback to simple fetch if EventSource is not available
      resolve({ content: [{ type: 'text', text: 'SSE monitoring requires the eventsource package. Install it with: npm install eventsource' }] });
    });
  });
}

async function removeMcpServerClaudeCode(server_id, claudePath) {
  // Check if claude command is available
  const claudeCheck = await checkClaudeCommandAvailable(claudePath);
  if (!claudeCheck.available) {
    const errorMessage = claudePath 
      ? `Error: Claude CLI command not found at provided path: ${claudePath}\n\nPlease verify the path is correct and the claude executable is accessible.\n\nError details: ${claudeCheck.error}`
      : `Error: Claude CLI command not found in PATH. Please install Claude Code CLI or provide the full path to the claude executable using the 'claude_path' parameter.\n\nInstall Claude Code CLI: npm install -g @anthropic-ai/claude-code\n\nAlternatively, you can use 'claude' client_type for Claude Desktop instead.\n\nError details: ${claudeCheck.error}`;
    
    return { 
      content: [{ 
        type: 'text', 
        text: errorMessage
      }], 
      isError: true 
    };
  }

  // For Claude Code, server_id could be either the config key name or the original server ID
  // We'll try to remove it directly as provided
  try {
    const execAsync = promisify(exec);
    
    const claudeCmd = claudeCheck.claudePath;
    const command = `${claudeCmd} mcp remove ${server_id}`;
    console.error(`[removeMcpServerClaudeCode] Executing: ${command}`);
    
    const { stdout, stderr } = await execAsync(command);
    
    if (stderr && !stderr.includes('warning')) {
      console.error(`[removeMcpServerClaudeCode] Command stderr: ${stderr}`);
      return { content: [{ type: 'text', text: `Error executing claude mcp remove: ${stderr}` }], isError: true };
    }
    
    console.error(`[removeMcpServerClaudeCode] Command stdout: ${stdout}`);
    return { content: [{ type: 'text', text: `Successfully removed server '${server_id}' from Claude Code using: ${command}` }] };
    
  } catch (execError) {
    console.error(`[removeMcpServerClaudeCode] Failed to execute claude mcp remove:`, execError);
    return { content: [{ type: 'text', text: `Error: Failed to execute claude mcp remove command. Make sure Claude Code CLI is installed and accessible. ${execError.message}` }], isError: true };
  }
}

async function remove_mcp_server_config(input) {
  const { server_id, client_type, config_file_path } = input;
  
  // Special handling for Claude Code - use native claude mcp remove command
  if (client_type === 'claude-code') {
    return await removeMcpServerClaudeCode(server_id, input.claude_path);
  }
  
  let configPath;

  try {
    configPath = await resolveAndValidateConfigPath(client_type, config_file_path);

    const keyToRemove = server_id;
    const isTomlFile = configPath.endsWith('.toml');
    let config;
    let removed = false;

    if (isTomlFile) {
      config = await readTomlConfigFile(configPath);
      if (config.mcp_servers?.[keyToRemove]) {
        console.error(`[remove_mcp_server_config] Removing server with name '${keyToRemove}' from key 'mcp_servers' in ${configPath}...`);
        delete config.mcp_servers[keyToRemove];
        removed = true;
        await writeTomlConfigFile(configPath, config);
      } else {
        console.warn(`[remove_mcp_server_config] Server with name '${keyToRemove}' not found in ${configPath}. No changes needed.`);
      }
    } else {
      config = await readConfigFile(configPath);
      // Determine which key to use for server entries
      const serversKey = config.hasOwnProperty('mcpServers')
          ? 'mcpServers'
          : (config.hasOwnProperty('servers') ? 'servers' : 'mcpServers');
      if (config[serversKey]?.[keyToRemove]) { // Check existence safely using the provided ID
        console.error(`[remove_mcp_server_config] Removing server with name '${keyToRemove}' from key '${serversKey}' in ${configPath}...`);
        delete config[serversKey][keyToRemove];
        removed = true;
        await writeConfigFile(configPath, config);
      } else {
        console.warn(`[remove_mcp_server_config] Server with name '${keyToRemove}' not found in ${configPath}. No changes needed.`);
      }
    }

    const resultMessage = removed
        ? `Successfully removed server entry with name '${keyToRemove}' from ${configPath}.`
        : `Server entry with name '${keyToRemove}' not found in ${configPath}.`;
    return { content: [{ type: 'text', text: resultMessage }] };

  } catch (error) {
    console.error('[remove_mcp_server_config] Error:', error);
    return { content: [{ type: 'text', text: `Error removing server config: ${error.message}` }], isError: true };
  }
}

// --- MCP Server Setup ---

const SearchMcpServersTool = {
  name: 'search_mcp_servers',
  description: `This is the primary tool for discovering and accessing new tools, methods, features, or capabilities. **If a user asks for a tool, method, feature, or capability that you do not currently have, you MUST use this tool to search for it in the MCP Finder registry.** For example, if a user asks for a browser tool, OCR, filesystem access, PDF parsing, or any other capability not present in your current toolset, use this tool to search by relevant keywords. This is the required first step to expand your available tools.`,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords to search for in tool name or description." },
      tag: { type: "string", description: "Specific tag to filter by." },
    },
    required: [],
  }
};

const GetMcpServerDetailsTool = {
  name: 'get_mcp_server_details',
  description: 'Retrieves detailed information about a specific MCP server/tool from the registry, including its manifest and installation details. Use this after finding a tool with search_mcp_servers to get more information, or directly use add_mcp_server_config to install it.',
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The unique MCPFinder ID of the MCP server received from search_mcp_servers." },
    },
    required: ["id"],
  }
};

const AddMcpServerConfigTool = {
  name: 'add_mcp_server_config',
  description: "Enables capabilities (e.g., tools, features) from a specific MCP server/tool. Add or update its configuration in the client application (e.g., Cursor, Claude Desktop, Windsurf, Claude Code, Codex) using server_id obtained from search_mcp_servers results. Provide EITHER client_type (see available options) OR config_file_path to specify the target config file.",
  inputSchema: {
    type: "object",
    properties: {
      client_type: { type: "string", description: "The type of client application (currently supported: 'cursor', 'claude', 'windsurf', 'claude-code', 'codex'). Mutually exclusive with config_file_path." },
      config_file_path: { type: "string", description: "Absolute path or path starting with '~' to the config file. Mutually exclusive with client_type." },
      server_id: { type: "string", description: "A unique MCPFinder ID of the MCP server received from search_mcp_servers." },
      mcp_definition: {
        type: "object",
        properties: {
          command: { type: "array", items: { type: "string" }, description: "The command and arguments to run the server. If omitted, defaults are fetched/merged." },
          env: { type: "object", additionalProperties: { type: "string" }, description: "Environment variables required by the server (e.g. API keys)." },
          workingDirectory: { type: "string", description: "The working directory for the server." }
        },
        description: "The MCP server definition object. Optional."
      },
      claude_path: { type: "string", description: "Full path to claude executable (only used for claude-code client_type when claude command is not in PATH)." }
    },
    required: ["server_id"]
  }
};

const RemoveMcpServerConfigTool = {
  name: 'remove_mcp_server_config',
  description: "Removes the configuration for a specific MCP server/tool from the client application (e.g., Cursor, Claude Desktop, Windsurf, Claude Code, Codex). Provide EITHER client_type (see available options) OR config_file_path to specify the target config file.",
  inputSchema: {
    type: "object",
    properties: {
      client_type: { type: "string", description: "The type of client application (currently supported: 'cursor', 'claude', 'windsurf', 'claude-code', 'codex'). Mutually exclusive with config_file_path." },
      config_file_path: { type: "string", description: "Absolute path or path starting with '~' to the config file. Mutually exclusive with client_type." },
      server_id: { type: "string", description: "The unique MCP server identifier (config key name) of the server configuration entry to remove." },
      claude_path: { type: "string", description: "Full path to claude executable (only used for claude-code client_type when claude command is not in PATH)." }
    },
    required: ["server_id"]
  }
};

const StreamMcpEventsTool = {
  name: 'stream_mcp_events',
  description: 'Monitor real-time events from the MCPfinder registry including new tool registrations, updates, and status changes. Returns a summary of events received during the monitoring period.',
  inputSchema: {
    type: "object",
    properties: {
      duration: { type: "number", description: "Duration in seconds to stream events (default: 30, max: 120)." },
      filter: { type: "array", items: { type: "string" }, description: "Event types to filter: tool.registered, tool.updated, tool.status_changed." },
      since: { type: "string", description: "ISO timestamp to get events from (default: 1 hour ago)." }
    },
    required: []
  }
};

const allTools = [
  SearchMcpServersTool,
  GetMcpServerDetailsTool,
  AddMcpServerConfigTool,
  RemoveMcpServerConfigTool,
  StreamMcpEventsTool,
];

// --- MCP Server Instance Creation (Common) ---
function createServerInstance(apiUrl) {
  globalApiUrl = apiUrl;
  return new Server({
    name: 'mcpfinder',
    version: '1.0.0',
    description: `This is the primary set of tools for discovering and accessing new tools, methods, features, or capabilities. If a user asks the AI for a tool, method, feature, or capability that it does not currently have, it can use this tool to search for it in the MCP Finder registry. For example, if a user requests a browser tool, OCR, filesystem access, PDF parsing, or any other capability not present in the AI's current toolset, it can use this tool to search by relevant keywords. This allows the AI to expand its available MCP server toolset.`,
    tools: allTools, // Use the defined array
  }, {
    capabilities: {
      tools: {}
    }
  });
}

// --- Request Handlers Setup (Common) ---
function setupRequestHandlers(server) {
    // Zod schemas for validation
    const toolSchemas = {
      search_mcp_servers: SearchServersInput,
      get_mcp_server_details: GetServerDetailsInput,
      add_mcp_server_config: AddServerConfigInput,
      remove_mcp_server_config: RemoveServerConfigInput,
      stream_mcp_events: StreamMcpEventsInput,
    };

    // Handlers map
    const toolHandlers = {
      search_mcp_servers,
      get_mcp_server_details,
      add_mcp_server_config,
      remove_mcp_server_config,
      stream_mcp_events,
    };

    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      return { tools: allTools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.error('Received CallToolRequest:', request.params.name); 
      const name = request.params.name;
      const toolArgs = request.params.arguments;
      const toolImplementation = toolHandlers[name];
      const zodSchema = toolSchemas[name];

      if (!toolImplementation || !zodSchema) {
        console.error(`Tool implementation or Zod schema not found for: ${name}`);
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }

      const parsedArgs = zodSchema.safeParse(toolArgs);
      if (!parsedArgs.success) {
        console.error(`Invalid arguments for tool ${name}:`, parsedArgs.error.errors);
        return { content: [{ type: 'text', text: `Invalid arguments: ${parsedArgs.error.message}` }], isError: true };
      }

      try {
        const result = await toolImplementation(parsedArgs.data);
        return result;
      } catch (error) {
        console.error(`Error executing tool ${name}:`, error);
        return { content: [{ type: 'text', text: `Error executing tool ${name}: ${error.message}` }], isError: true };
      }
    });
}

// --- Stdio Mode Start Function ---
async function startStdioServer(apiUrl) {
    console.error("MCPfinder - Use --help to see all transport options and commands");
    console.error("");
    console.error("Initializing MCP Finder Server in Stdio mode...");
    serverInstance = createServerInstance(apiUrl);
    setupRequestHandlers(serverInstance);

    const transport = new StdioServerTransport();

    transport.onclose = () => {
        console.error("Stdio transport closed. Server process will remain alive.");
        // process.exit(0); // Keep process alive even if transport closes
    };

    try {
        // Keep the process alive indefinitely in stdio mode BEFORE connect
        setInterval(() => {}, 1 << 30); 
        await serverInstance.connect(transport);
        console.error("🚀 MCP Finder Server (Stdio) connected and ready.");
        console.error(`   Using API: ${globalApiUrl}`);
        console.error("   Waiting for MCP requests via stdin...");
    } catch (error) {
        console.error("!!! Failed to connect server to stdio transport:", error);
        process.exit(1);
    }
}

// --- HTTP Mode Start Function ---
async function startHttpServer(port, apiUrl) {
  try {
    console.error("Initializing MCP Finder Server in HTTP mode...");
    serverInstance = createServerInstance(apiUrl);
    setupRequestHandlers(serverInstance);

    const app = express();
    app.use(express.json());

    httpTransportInstance = new StreamableHTTPServerTransport({
        server: serverInstance,
        endpoint: '/',
    });

    app.all(httpTransportInstance.endpoint, (req, res) => {
        httpTransportInstance.handleRequest(req, res);
    });

    runningHttpServer = app.listen(port, () => {
      console.error(`🚀 MCP Finder Server (HTTP) listening on port ${port}`);
      console.error(`   Using API: ${globalApiUrl}`);
    });

    runningHttpServer.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`!!! Error: Port ${port} is already in use.`);
      } else {
        console.error("!!! HTTP server error:", error);
      }
      process.exit(1);
    });

  } catch (error) {
    console.error("!!! Failed to start HTTP server:", error);
    process.exit(1);
  }
}

// --- Graceful Shutdown Handler ---
async function shutdown() {
    console.error('\\nReceived shutdown signal...');

    if (runHttp) {
        console.error('Shutting down HTTP server and transport...');
        if (httpTransportInstance) {
            try {
                await httpTransportInstance.close();
            } catch (transportError) {
                console.error('Error closing HTTP transport:', transportError);
            }
        }
        if (runningHttpServer) {
            runningHttpServer.close((err) => {
                if (err) {
                    console.error('Error closing HTTP server:', err);
                    process.exit(1);
                } else {
                    console.error('HTTP server closed.');
                    process.exit(0);
                }
            });
            setTimeout(() => {
                console.error('HTTP shutdown timeout exceeded, forcing exit.');
                process.exit(1);
            }, 5000);
        } else {
             process.exit(0); // No HTTP server was running
        }
    } else {
        console.error('Exiting MCP server (stdio)...');
        // Stdio transport relies on process exit or its own onclose handler
        process.exit(0);
    }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Main Execution Logic ---

if (showHelp || hasUnknownCommand) {
  if (hasUnknownCommand) {
    console.log("Unknown command or invalid arguments. See usage below:\n");
  }
  console.log(helpText);
  process.exit(0);
}

// Handle command line commands
if (isSetupCommand) {
  (async () => {
    try {
      console.log("Running interactive setup...");
      const { runSetup } = await import('./src/setup.js');
      await runSetup();
      console.log("Setup completed successfully. You can now ask the AI to search for and install new tools.");
      process.exit(0);
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND') {
          console.error("Error: Setup module ('./src/setup.js') not found.");
      } else {
          console.error("Setup failed:", error);
      }
      process.exit(1);
    }
  })();
} else if (isRegisterCommand) {
  (async () => {
    try {
      console.log("Running MCP server registration...");
      const { runRegister } = await import('./src/register.js');
      
      // Extract headless mode options
      const headlessOptions = {
        headless: args.includes('--headless'),
        packageOrUrl: args.find((arg, i) => i > 0 && args[i-1] === 'register' && !arg.startsWith('--')),
        description: getArgValue('--description'),
        tags: getArgValue('--tags'),
        authToken: getArgValue('--auth-token'),
        requiresApiKey: args.includes('--requires-api-key') ? 'y' : (args.includes('--headless') ? 'n' : undefined),
        authType: getArgValue('--auth-type') || 'api-key',
        keyName: getArgValue('--key-name'),
        authInstructions: getArgValue('--auth-instructions'),
        confirm: getArgValue('--confirm') || (args.includes('--headless') ? 'y' : undefined),
        manualCapabilities: getArgValue('--manual-capabilities') || (args.includes('--headless') ? 'n' : undefined),
        hasTools: getArgValue('--has-tools') || (args.includes('--headless') ? 'y' : undefined),
        hasResources: getArgValue('--has-resources') || (args.includes('--headless') ? 'n' : undefined),
        hasPrompts: getArgValue('--has-prompts') || (args.includes('--headless') ? 'n' : undefined),
        useUvx: args.includes('--use-uvx')
      };
      
      await runRegister(headlessOptions);
      process.exit(0);
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND') {
          console.error("Error: Register module ('./src/register.js') not found.");
      } else {
          console.error("Registration failed:", error);
      }
      process.exit(1);
    }
  })();
} else if (isScrapeCommand) {
  (async () => {
    try {
      console.log("Running MCP server scraping...");
      const runOnce = args.includes('--once');
      
      if (runOnce) {
        const { runOnce: runScrapeOnce } = await import('./src/daily-scraper.js');
        await runScrapeOnce();
      } else {
        const { runAllScrapers } = await import('./src/scrapers/run-all-scrapers.js');
        await runAllScrapers();
      }
      
      process.exit(0);
    } catch (error) {
      console.error("Scraping failed:", error);
      process.exit(1);
    }
  })();
} else if (isScheduleScraperCommand) {
  (async () => {
    try {
      console.log("Starting daily scraper scheduler...");
      const { startDailyScheduler } = await import('./src/daily-scraper.js');
      await startDailyScheduler();
      // Keep running
    } catch (error) {
      console.error("Failed to start daily scheduler:", error);
      process.exit(1);
    }
  })();
} else {
  // Proceed with normal server startup only if no special command is used
  const finalPort = cliPort ? parseInt(cliPort, 10) : (process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : DEFAULT_PORT);
  let validatedPort = finalPort;
  const finalApiUrl = cliApiUrl || process.env.MCPFINDER_API_URL || DEFAULT_API_URL;

  // Validate Port
  if (isNaN(finalPort) || finalPort <= 0 || finalPort > 65535) {
      console.error(`Invalid port specified: ${cliPort || process.env.MCP_PORT}. Using default ${DEFAULT_PORT}.`);
      validatedPort = DEFAULT_PORT;
  }

  (async () => {
      if (runHttp) {
          console.error(`Starting HTTP mode on port ${validatedPort}`);
          await startHttpServer(validatedPort, finalApiUrl);
      } else {
          console.error("Starting Stdio mode");
          await startStdioServer(finalApiUrl);
      }
  })().catch(err => {
      console.error("!!! Unhandled error during server startup:", err);
      process.exit(1);
  });
}
