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
MCP Finder Server

Manages local MCP configurations for clients like Cursor and Claude.
Communicates with the MCP Finder Registry API (https://mcpfinder.dev/api).

Usage: node index.js [options]

Options:
  --setup           Run the interactive setup to configure a client.
  --http            Run the server in HTTP mode. Default is Stdio mode.
  --port <number>   Port for HTTP mode (overrides MCP_PORT env var). Default: ${DEFAULT_PORT}
  --api-url <url>   URL of the MCP Finder Registry API (overrides MCPFINDER_API_URL env var). Default: ${DEFAULT_API_URL}
  --help            Display this help message.

Environment Variables:
  MCP_PORT           Port for HTTP mode (default: ${DEFAULT_PORT}).
  MCPFINDER_API_URL  URL of the MCP Finder Registry API (default: ${DEFAULT_API_URL}).
`;

// --- Argument Parsing ---
const args = process.argv.slice(2);
const runHttp = args.includes('--http');
const showHelp = args.includes('--help');
const runSetupFlag = args.includes('--setup');

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
    client_type: z.string().describe("The type or name of the client application (e.g., 'cursor', 'claude', 'windsurf')."),
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
}).and(ClientIdentifierSchema);

const RemoveServerConfigInput = z.object({
  server_id: z.string().describe("The unique identifier of the server configuration entry to remove."),
}).and(ClientIdentifierSchema);

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
        if (manifest.url && !manifest.url.startsWith('http://') && !manifest.url.startsWith('https://')) {
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

    // Remove http(s) prefix
    key = key.replace(/^https?:\/\//, '');

    // Convert to lowercase
    key = key.toLowerCase();

    // Replace invalid characters (not a-z, 0-9, _) with a single underscore
    key = key.replace(/[^a-z0-9_]+/g, '_');

    // Remove leading/trailing underscores
    key = key.replace(/^_+|_+$/g, '');

    // Truncate
    if (key.length > MAX_KEY_LENGTH) {
        key = key.substring(0, MAX_KEY_LENGTH);
        // Ensure it doesn't end with underscore after truncation
        key = key.replace(/_+$/g, '');
    }

    // Final fallback if sanitization resulted in an empty string
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

async function add_mcp_server_config(input) {
  // Use globalApiUrl for fetching defaults
  const { server_id, client_type, config_file_path, mcp_definition } = input;

  let resolvedPath;
  try {
      resolvedPath = await resolveAndValidateConfigPath(client_type, config_file_path);
      if (!resolvedPath) throw new Error('Failed to determine config file path.'); // Should not happen if resolve func works
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
      let defaultCommand = [];
      // If the URL exists and doesn't look like http:// or https://, assume it's a package name
      if (manifest.url && !manifest.url.startsWith('http://') && !manifest.url.startsWith('https://')) {
        defaultCommand = ['npx', '-y', manifest.url];
      } else {
         console.warn(`[add_mcp_server_config] Could not determine default command for ${server_id} from manifest URL.`);
      }

      // Determine the command to use: prioritize non-empty manifest command, then URL-based default
      let commandToUse = defaultCommand; // Start with URL-based default
      if (manifest?.installation?.command && Array.isArray(manifest.installation.command)) {
          if (manifest.installation.command.length > 0) {
               // If API provided a non-empty command, use it instead of the URL-based default
               commandToUse = manifest.installation.command;
               console.error(`[add_mcp_server_config] Using command from fetched manifest installation: ${JSON.stringify(commandToUse)}`);
          } else {
               // API provided an empty command array, stick with the URL-based default (if any)
               console.error(`[add_mcp_server_config] Manifest installation command is empty, using URL-based default (if available): ${JSON.stringify(commandToUse)}`);
          }
      } else {
          // Manifest did not provide installation.command, stick with the URL-based default
          console.error(`[add_mcp_server_config] Manifest installation command missing, using URL-based default (if available): ${JSON.stringify(commandToUse)}`);
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

  try {
    const config = await readConfigFile(resolvedPath);

    // Determine which key to use for server entries: prefer 'mcpServers', else 'servers'
    const serversKey = config.hasOwnProperty('mcpServers')
        ? 'mcpServers'
        : (config.hasOwnProperty('servers') ? 'servers' : 'mcpServers'); // Default to mcpServers if neither exists
    if (!config[serversKey]) {
        config[serversKey] = {};
    }

    const originalCommandArray = finalDefinition.command; // Assuming it's an array initially

    // Format command based on client type for compatibility
    console.warn(`[add_mcp_server_config] Applying standard command/args formatting.`);
    if (Array.isArray(originalCommandArray) && originalCommandArray.length > 0) {
        finalDefinition.command = originalCommandArray[0]; // Default to command string
        finalDefinition.args = originalCommandArray.slice(1); // Default to args array
        console.warn(`[add_mcp_server_config] Formatted command: "${finalDefinition.command}", args: ${JSON.stringify(finalDefinition.args)}`);
    } else {
        // If source wasn't a valid array, ensure args is not present
        finalDefinition.command = originalCommandArray; // Preserve original structure
        delete finalDefinition.args;
        console.error(`[add_mcp_server_config] Original command was not a non-empty array:`, originalCommandArray);
    }

    // Add or update the server entry using the generated key
    config[serversKey][configKey] = finalDefinition;

    await writeConfigFile(resolvedPath, config);

    let successMessage = `Successfully added/updated server '${server_id}' (using key '${configKey}') in ${resolvedPath}.`;
    if (client_type === 'claude' || config_file_path) {
      successMessage += ' Restart client application for changes to take effect.';
    }

    return { content: [{ type: 'text', text: successMessage }] };

  } catch (error) {
    console.error('[add_mcp_server_config] Error:', error);
    return { content: [{ type: 'text', text: `Error adding/updating server config: ${error.message}` }], isError: true };
  }
}

async function remove_mcp_server_config(input) {
  const { server_id, client_type, config_file_path } = input;
  let configPath;

  try {
    configPath = await resolveAndValidateConfigPath(client_type, config_file_path);

    const config = await readConfigFile(configPath);

    // Determine which key to use for server entries
    const serversKey = config.hasOwnProperty('mcpServers')
        ? 'mcpServers'
        : (config.hasOwnProperty('servers') ? 'servers' : 'mcpServers');
    let removed = false;
    if (config[serversKey]?.[server_id]) { // Check existence safely
      console.error(`[remove_mcp_server_config] Removing server '${server_id}' from key '${serversKey}' in ${configPath}...`);
      delete config[serversKey][server_id];
      removed = true;
      await writeConfigFile(configPath, config);
    } else {
      console.warn(`[remove_mcp_server_config] Server '${server_id}' not found in ${configPath}. No changes needed.`);
    }

    const resultMessage = removed
        ? `Successfully removed server '${server_id}' from ${configPath}.`
        : `Server '${server_id}' not found in ${configPath}.`;
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
      id: { type: "string", description: "The unique MCPFinder ID of the MCP server." },
    },
    required: ["id"],
  }
};

const AddMcpServerConfigTool = {
  name: 'add_mcp_server_config',
  description: "Enables capabilities (e.g., tools, features) from a specific MCP server/tool. Add or update its configuration in the client application (e.g., Cursor, Claude, VS Code) using server_id obtained from search_mcp_servers results. Provide EITHER client_type (see available options) OR config_file_path to specify the target config file.",
  inputSchema: {
    type: "object",
    properties: {
      client_type: { type: "string", description: "The type of client application (currently supported: 'cursor', 'claude', 'windsurf'). Mutually exclusive with config_file_path." },
      config_file_path: { type: "string", description: "Absolute path or path starting with '~' to the config file. Mutually exclusive with client_type." },
      server_id: { type: "string", description: "A unique identifier for the server configuration entry." },
      mcp_definition: {
        type: "object",
        properties: {
          command: { type: "array", items: { type: "string" }, description: "The command and arguments to run the server. If omitted, defaults are fetched/merged." },
          env: { type: "object", additionalProperties: { type: "string" }, description: "Environment variables required by the server (e.g. API keys)." },
          workingDirectory: { type: "string", description: "The working directory for the server." }
        },
        description: "The MCP server definition object. Optional."
      }
    },
    required: ["server_id"]
  }
};

const RemoveMcpServerConfigTool = {
  name: 'remove_mcp_server_config',
  description: "Removes the configuration for a specific MCP server/tool from the client application (e.g., Cursor, Claude). Provide EITHER client_type (see available options) OR config_file_path to specify the target config file.",
  inputSchema: {
    type: "object",
    properties: {
      client_type: { type: "string", description: "The type of client application (currently supported: 'cursor', 'claude', 'windsurf'). Mutually exclusive with config_file_path." },
      config_file_path: { type: "string", description: "Absolute path or path starting with '~' to the config file. Mutually exclusive with client_type." },
      server_id: { type: "string", description: "The unique identifier of the server configuration entry to remove." }
    },
    required: ["server_id"]
  }
};

const allTools = [
  SearchMcpServersTool,
  GetMcpServerDetailsTool,
  AddMcpServerConfigTool,
  RemoveMcpServerConfigTool,
];

const toolImplementations = {
  search_mcp_servers: search_mcp_servers,
  get_mcp_server_details: get_mcp_server_details,
  add_mcp_server_config: add_mcp_server_config,
  remove_mcp_server_config: remove_mcp_server_config,
};

// --- MCP Server Instance Creation (Common) ---
function createServerInstance(apiUrl) {
  globalApiUrl = apiUrl;
  return new Server({
    name: 'mcpfinder',
    version: '1.0.0',
    description: 'Provides tools to search the MCP Finder registry and manage local MCP client configurations.',
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
    };

    // Handlers map
    const toolHandlers = {
      search_mcp_servers,
      get_mcp_server_details,
      add_mcp_server_config,
      remove_mcp_server_config,
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
    console.error("Initializing MCP Finder Server in Stdio mode...");
    serverInstance = createServerInstance(apiUrl);
    setupRequestHandlers(serverInstance);

    const transport = new StdioServerTransport();

    transport.onclose = () => {
        console.error("Stdio transport closed. Server process will remain alive.");
        // process.exit(0); // Keep process alive even if transport closes
    };

    try {
        await serverInstance.connect(transport);
        console.error("🚀 MCP Finder Server (Stdio) connected and ready.");
        console.error(`   Using API: ${globalApiUrl}`);
        console.error("   Waiting for MCP requests via stdin...");
        // Keep the process alive indefinitely in stdio mode
        setInterval(() => {}, 1 << 30); // Use a very large interval
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

if (showHelp) {
  console.log(helpText);
  process.exit(0);
}

// Handle --setup flag BEFORE other logic
if (runSetupFlag) {
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
} else {
  // Proceed with normal server startup only if --setup is not used
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
