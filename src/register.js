#!/usr/bin/env node

import readline from 'readline';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import crypto from 'crypto';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
// Removed ora import - using simple console logging instead
import chalk from 'chalk';

// Function to create a readline interface
function createPromptInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

// Function to ask a question and get the answer
function askQuestion(rl, query) {
    return new Promise((resolve, reject) => {
        // Set a timeout to prevent hanging
        const timeout = setTimeout(() => {
            reject(new Error('Input timeout - no response received'));
        }, 60000); // 60 second timeout
        
        // Clear any pending input buffer
        if (rl._line_buffer) {
            rl._line_buffer = '';
        }
        
        rl.question(query, (answer) => {
            clearTimeout(timeout);
            const trimmedAnswer = answer ? answer.trim() : answer;
            // Debug logging removed - flow is working correctly
            if (trimmedAnswer === undefined) {
                reject(new Error('Input interrupted'));
            } else {
                resolve(trimmedAnswer);
            }
        });
    });
}

// Helper function to handle both headless and interactive prompts
function getInput(rl, query, headlessValue = null, defaultValue = '') {
    if (headlessValue !== null && headlessValue !== undefined) {
        console.log(chalk.dim(`${query} [headless] ${headlessValue}`));
        return Promise.resolve(headlessValue);
    }
    if (!rl) {
        return Promise.resolve(defaultValue);
    }
    return askQuestion(rl, query);
}

// Function to validate package name/URL
function isValidPackageNameOrUrl(input) {
    if (!input || typeof input !== 'string') return false;
    const trimmed = input.trim();
    if (!trimmed) return false;
    
    // Check if it's a URL
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        try {
            new URL(trimmed);
            return true;
        } catch {
            return false;
        }
    }
    
    // Check if it's a valid npm package name
    // Must be longer than 1 character and follow npm naming rules
    if (trimmed.length <= 1) return false;
    
    // Reject common invalid names
    const invalidNames = ['packages', 'npm', 'node', 'js', 'javascript', 'mcp', 'server'];
    if (invalidNames.includes(trimmed.toLowerCase())) return false;
    
    // Allow npm packages and GitHub-style org/repo names, with optional version tags
    // Matches: package, @scope/package, package@version, @scope/package@version, org/repo
    return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-._~]+)?$|^[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*$/i.test(trimmed);
}

// Function to clean and validate a tag
function cleanTag(tag) {
    if (typeof tag !== 'string') return null;
    // Convert to lowercase, replace invalid chars with hyphens, collapse multiple hyphens, trim hyphens
    const cleaned = tag.toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    
    const tagPattern = /^[a-z0-9-]+$/;
    return (cleaned && tagPattern.test(cleaned)) ? cleaned : null;
}

// Function to probe server for minimal information
async function probeServerMinimal(url) {
    const info = {
        headers: {},
        auth: {},
        endpoints: [],
        metadata: {}
    };
    
    try {
        // 1. OPTIONS request
        const optionsResponse = await fetch(url, { 
            method: 'OPTIONS',
            headers: { 'Origin': 'https://mcpfinder.dev' }
        });
        
        if (optionsResponse.ok) {
            info.headers.allowMethods = optionsResponse.headers.get('access-control-allow-methods');
            info.headers.allowHeaders = optionsResponse.headers.get('access-control-allow-headers');
            info.headers.allowOrigin = optionsResponse.headers.get('access-control-allow-origin');
        }
        
        // 2. GET request for metadata
        const getResponse = await fetch(url, { 
            method: 'GET',
            headers: { 'Accept': 'text/html,application/json' }
        });
        
        if (getResponse.ok) {
            const contentType = getResponse.headers.get('content-type');
            info.metadata.contentType = contentType;
            
            if (contentType?.includes('text/html')) {
                const text = await getResponse.text();
                const titleMatch = text.match(/<title>(.*?)<\/title>/);
                if (titleMatch) {
                    info.metadata.title = titleMatch[1];
                }
                info.metadata.containsMCP = text.includes('MCP') || text.includes('Model Context Protocol');
            }
        }
        
        // 3. Analyze auth error
        const initResponse = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2024-11-05' }
            })
        });
        
        if (initResponse.status === 401) {
            info.auth.required = true;
            const authHeader = initResponse.headers.get('www-authenticate');
            if (authHeader) {
                info.auth.wwwAuthenticate = authHeader;
            }
            
            try {
                const error = await initResponse.json();
                if (error.error?.data) {
                    info.auth.details = error.error.data;
                }
            } catch (e) {}
        } else if (initResponse.ok) {
            // Server might not require auth
            info.auth.required = false;
        }
        
    } catch (e) {
        // Ignore probe errors
    }
    
    return info;
}

// Function to introspect MCP server
export async function introspectMCPServer(packageOrUrl, tempDir = null, authToken = null, headlessOptions = {}) {
    const isUrl = packageOrUrl.startsWith('http://') || packageOrUrl.startsWith('https://');
    let transport;
    let client;
    let originalFetch = null;
    
    
    try {
        if (isUrl) {
            const url = new URL(packageOrUrl);
            
            // Check if URL ends with /sse - use SSE transport
            if (packageOrUrl.endsWith('/sse')) {
                // Use SSE transport for SSE endpoints
                transport = new SSEClientTransport(url);
                
            } else {
                // Try to detect if it's an SSE endpoint by making a GET request
                try {
                    const testResponse = await fetch(packageOrUrl, {
                        method: 'GET',
                        headers: {
                            'Accept': 'text/event-stream',
                            ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
                        }
                    });
                    
                    const contentType = testResponse.headers.get('content-type');
                    if (contentType && contentType.includes('text/event-stream')) {
                        // It's an SSE endpoint
                        transport = new SSEClientTransport(url);
                    } else {
                        // Use StreamableHTTP transport for modern HTTP endpoints
                        transport = new StreamableHTTPClientTransport(url);
                    }
                } catch (e) {
                    // Default to StreamableHTTP if detection fails
                    transport = new StreamableHTTPClientTransport(url);
                }
            }
        } else {
            // STDIO transport for npm/Python packages
            const actualTempDir = tempDir || mkdtempSync(join(tmpdir(), 'mcp-register-'));
            
            // Determine if it's a Python package (uvx) based on naming patterns or explicit uvx prefix
            const isPythonPackage = packageOrUrl.startsWith('uvx:') || 
                                   packageOrUrl.includes('_') || // Python packages often use underscores
                                   packageOrUrl.endsWith('.py') ||
                                   false; // Will be detected later if uvx is specified in headless options
            
            if (isPythonPackage || (headlessOptions && headlessOptions.useUvx)) {
                // Use uvx for Python packages
                const cleanPackage = packageOrUrl.replace(/^uvx:/, ''); // Remove uvx: prefix if present
                transport = new StdioClientTransport({
                    command: 'uvx',
                    args: [cleanPackage],
                    env: process.env,
                    stderr: 'pipe',
                    cwd: actualTempDir
                });
            } else {
                // Use npx for npm packages (default)
                transport = new StdioClientTransport({
                    command: 'npx',
                    args: [packageOrUrl],
                    env: process.env,
                    stderr: 'pipe',
                    cwd: actualTempDir
                });
            }
        }
        
        // Connect to the MCP server
        const clientOptions = { name: 'mcpfinder-register', version: '1.0.0' };
        
        // Store original fetch for cleanup
        let originalFetch = null;
        
        // Add auth token if provided
        if (authToken && isUrl) {
            // Create auth provider that works for both SSE and HTTP transports
            transport._authProvider = {
                tokens: async () => ({
                    access_token: authToken,
                    token_type: 'Bearer'
                })
            };
            
            // Override fetch to ensure auth headers are always sent
            originalFetch = global.fetch;
            
            global.fetch = async (url, options = {}) => {
                // Only add auth header for requests to the MCP server
                if (url.toString().startsWith(packageOrUrl)) {
                    options.headers = {
                        ...options.headers,
                        'Authorization': `Bearer ${authToken}`
                    };
                }
                return originalFetch(url, options);
            };
        }
        
        client = new Client(clientOptions);
        
        try {
            
            // For SSE transports, add a timeout since some servers send non-standard keepalives
            if (transport.constructor.name === 'SSEClientTransport') {
                const connectPromise = client.connect(transport);
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('SSE connection timeout')), 5000)
                );
                
                try {
                    await Promise.race([connectPromise, timeoutPromise]);
                } catch (sseError) {
                    console.log(chalk.dim('SSE connection failed, trying HTTP transport...'));
                    // Try HTTP transport as fallback
                    try {
                        await transport.close();
                    } catch (e) {
                        // Ignore close errors
                    }
                    
                    // Create a new client for the HTTP transport
                    client = new Client(clientOptions);
                    transport = new StreamableHTTPClientTransport(new URL(packageOrUrl));
                    
                    if (authToken) {
                        transport._authProvider = {
                            tokens: async () => ({
                                access_token: authToken,
                                token_type: 'Bearer'
                            })
                        };
                    }
                    
                    await client.connect(transport);
                }
            } else {
                await client.connect(transport);
            }
            
        } catch (connectError) {
            // Restore fetch before throwing
            if (originalFetch) {
                global.fetch = originalFetch;
            }
            throw connectError;
        }
        
        // List available tools - this is the primary MCP viability test
        const toolsResult = await client.listTools();
        const tools = toolsResult.tools || [];
        
        // Get server info and capabilities
        const serverInfo = client.serverInfo || {};
        const capabilities = client.serverCapabilities || {};
        
        // List resources if supported
        let resources = [];
        if (capabilities?.resources) {
            const resourcesResult = await client.listResources();
            resources = resourcesResult.resources || [];
        }
        
        // List prompts if supported
        let prompts = [];
        if (capabilities?.prompts) {
            const promptsResult = await client.listPrompts();
            prompts = promptsResult.prompts || [];
        }
        
        return {
            isValid: true,
            serverInfo,
            capabilities,
            tools,
            resources,
            prompts
        };
        
    } catch (error) {
        // If it's a URL and direct connection failed, try via mcp-remote (but not for GitHub)
        if (isUrl && !packageOrUrl.includes('github.com/')) {
            console.log(chalk.yellow('\nDirect connection failed. Trying via mcp-remote as stdio transport...'));
            
            try {
                // Create a temp directory for mcp-remote
                const mcpRemoteTempDir = tempDir || mkdtempSync(join(tmpdir(), 'mcp-remote-'));
                
                // Use mcp-remote as stdio transport
                // mcp-remote handles OAuth authentication automatically
                const mcpRemoteTransport = new StdioClientTransport({
                    command: 'npx',
                    args: ['mcp-remote', packageOrUrl],
                    env: {
                        ...process.env,
                        // Try different auth token environment variables
                        ...(authToken ? { 
                            MCP_AUTH_TOKEN: authToken,
                            AUTH_TOKEN: authToken,
                            BEARER_TOKEN: authToken,
                            TOKEN: authToken
                        } : {})
                    },
                    stderr: 'pipe',
                    cwd: mcpRemoteTempDir
                });
                
                const mcpRemoteClient = new Client({ name: 'mcpfinder-register', version: '1.0.0' });
                await mcpRemoteClient.connect(mcpRemoteTransport);
                
                // Get server info and capabilities
                const toolsResult = await mcpRemoteClient.listTools();
                const tools = toolsResult.tools || [];
                const serverInfo = mcpRemoteClient.serverInfo || {};
                const capabilities = mcpRemoteClient.serverCapabilities || {};
                
                // List resources if supported
                let resources = [];
                if (capabilities?.resources) {
                    const resourcesResult = await mcpRemoteClient.listResources();
                    resources = resourcesResult.resources || [];
                }
                
                // List prompts if supported
                let prompts = [];
                if (capabilities?.prompts) {
                    const promptsResult = await mcpRemoteClient.listPrompts();
                    prompts = promptsResult.prompts || [];
                }
                
                // Clean up
                await mcpRemoteClient.close();
                await mcpRemoteTransport.close();
                
                console.log(chalk.green('✅ Successfully connected via mcp-remote'));
                
                return {
                    isValid: true,
                    serverInfo,
                    capabilities,
                    tools,
                    resources,
                    prompts,
                    useMcpRemote: true // Flag that this server needs mcp-remote
                };
            } catch (mcpRemoteError) {
                // mcp-remote also failed
                console.log(chalk.red('❌ mcp-remote connection also failed'));
                console.log(chalk.dim(`mcp-remote error: ${mcpRemoteError.message}`));
            }
        }
        
        // Introspection error already shown in main flow
        return {
            isValid: false,
            error: error.message || 'Unknown error'
        };
    } finally {
        // Cleanup
        try {
            if (client) {
                await client.close();
            }
        } catch (e) {
            console.error(chalk.dim('Debug: Error closing client:', e.message));
        }
        
        try {
            if (transport) {
                await transport.close();
            }
        } catch (e) {
            console.error(chalk.dim('Debug: Error closing transport:', e.message));
        }
        
        // Restore original fetch if it was overridden
        if (originalFetch) {
            global.fetch = originalFetch;
        }
        
    }
}

// Function to generate manifest
function generateManifest(packageOrUrl, introspectionResult, additionalInfo = {}) {
    const { serverInfo, tools, resources, prompts } = introspectionResult;
    
    // Build capabilities array
    const capabilities = [];
    
    // Check if this is manual or minimal registration
    const isManual = tools.some(t => t.name === 'unknown') || 
                     resources.some(r => r.name === 'unknown') || 
                     prompts.some(p => p.name === 'unknown');
    const isMinimal = additionalInfo.isMinimal;
    
    if (isMinimal) {
        // For minimal registration, just indicate unknown capabilities
        capabilities.push({
            name: 'capabilities_unknown',
            type: 'tool',
            description: 'Server capabilities cannot be determined without authentication'
        });
    } else if (isManual) {
        // For manual registration, create generic capability entries
        if (tools.length > 0) {
            capabilities.push({
                name: 'tools_available',
                type: 'tool',
                description: 'Tools will be available after authentication'
            });
        }
        if (resources.length > 0) {
            capabilities.push({
                name: 'resources_available',
                type: 'resource',
                description: 'Resources will be available after authentication'
            });
        }
        if (prompts.length > 0) {
            capabilities.push({
                name: 'prompts_available',
                type: 'prompt',
                description: 'Prompts will be available after authentication'
            });
        }
    } else {
        // Add actual capabilities from introspection
        tools.forEach(tool => {
            capabilities.push({
                name: tool.name,
                type: 'tool',
                description: tool.description || ''
            });
        });
        
        resources.forEach(resource => {
            capabilities.push({
                name: resource.name || resource.uri,
                type: 'resource',
                description: resource.description || ''
            });
        });
        
        prompts.forEach(prompt => {
            capabilities.push({
                name: prompt.name,
                type: 'prompt',
                description: prompt.description || ''
            });
        });
    }
    
    // Determine installation instructions
    const isUrl = packageOrUrl.startsWith('http://') || packageOrUrl.startsWith('https://');
    const isGitHub = isUrl && packageOrUrl.includes('github.com/');
    
    // If this server needs mcp-remote (failed HTTP/SSE connection), use stdio transport
    const useMcpRemote = additionalInfo.useMcpRemote;
    let installation;
    
    if (isGitHub) {
        // GitHub repos need to be cloned and run locally
        installation = {
            command: 'git',
            args: ['clone', packageOrUrl]
        };
    } else if (isUrl) {
        installation = useMcpRemote ? {
            command: 'npx',
            args: ['mcp-remote', packageOrUrl]
        } : undefined;
    } else {
        // Check if it's a Python package (uvx)
        const isPythonPackage = packageOrUrl.startsWith('uvx:') || 
                               additionalInfo.useUvx || 
                               (additionalInfo.installCommand === 'uvx');
        
        if (isPythonPackage) {
            const cleanPackage = packageOrUrl.replace(/^uvx:/, ''); // Remove uvx: prefix if present
            installation = {
                command: 'uvx',
                args: [cleanPackage]
            };
        } else {
            installation = {
                command: 'npx',
                args: [packageOrUrl]
            };
        }
    }
    
    // Determine a good name for the manifest
    let name = serverInfo?.name;
    if (!name) {
        if (isUrl) {
            // Extract a name from URL (e.g., https://mcp.deepwiki.com/sse -> deepwiki)
            const urlObj = new URL(packageOrUrl);
            const hostname = urlObj.hostname;
            name = hostname.replace(/^(www\.|mcp\.)/, '').replace(/\.(com|org|net|io)$/, '');
        } else {
            // Use package name
            name = packageOrUrl;
        }
    }
    
    const manifest = {
        name: name,
        description: additionalInfo.description || serverInfo?.description || `MCP server: ${packageOrUrl}`,
        url: packageOrUrl,
        protocol_version: 'MCP/1.0',
        capabilities,
        tags: additionalInfo.tags || [],
        ...(installation && { installation })
    };
    
    // Add auth if required
    if (additionalInfo.requiresApiKey) {
        manifest.auth = {
            type: additionalInfo.type || 'api-key',
            instructions: additionalInfo.authInstructions || 'Set the API key as an environment variable'
        };
        
        // Only add key_name for api-key type
        if (manifest.auth.type === 'api-key' && additionalInfo.keyName) {
            manifest.auth.key_name = additionalInfo.keyName;
        }
    }
    
    return manifest;
}

// Function to submit to registry
async function submitToRegistry(manifest) {
    const apiUrl = process.env.MCPFINDER_API_URL || 'https://mcpfinder.dev';
    const secret = process.env.MCP_REGISTRY_SECRET;
    
    const payload = JSON.stringify(manifest);
    const headers = {
        'Content-Type': 'application/json'
    };
    
    // If secret is provided, add HMAC authentication
    if (secret) {
        const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
        headers['Authorization'] = `HMAC ${signature}`;
    }
    
    const response = await fetch(`${apiUrl}/api/v1/register`, {
        method: 'POST',
        headers,
        body: payload
    });
    
    const responseText = await response.text();
    let result;
    
    try {
        result = JSON.parse(responseText);
    } catch (e) {
        console.error('Failed to parse response:', responseText);
        throw new Error('Invalid JSON response from server: ' + responseText.substring(0, 100));
    }
    
    if (!response.ok) {
        throw new Error(result.error || result.message || 'Registration failed');
    }
    
    return result;
}

// Main registration function
export async function runRegister(headlessOptions = {}) {
    console.log(chalk.bold.blue('\n📋 Register Your MCP Server with MCPfinder\n'));
    
    // Ensure stdin doesn't close prematurely
    process.stdin.resume();
    // Ensure we're not in raw mode which can interfere with readline
    if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
    }
    
    const rl = headlessOptions.headless ? null : createPromptInterface();
    
    if (rl) {
        // Set encoding to handle paste properly
        rl.input.setEncoding('utf8');
        
        // Remove any existing line event listeners to prevent issues
        rl.removeAllListeners('line');
    }
    let tempDir = null;
    
    try {
        // Keep asking for package name/URL until we get a valid MCP server
        let packageOrUrl = '';
        let introspectionResult = null;
        
        // Default introspection result for failed connections
        const defaultIntrospectionResult = {
            isValid: false,
            isManual: false,
            isMinimal: false,
            error: 'Failed to connect',
            tools: [],
            resources: [],
            prompts: [],
            capabilities: {},
            serverInfo: null,
            probeInfo: null
        };
        
        // In headless mode, get package from options
        if (headlessOptions.headless && headlessOptions.packageOrUrl) {
            packageOrUrl = headlessOptions.packageOrUrl;
            if (!isValidPackageNameOrUrl(packageOrUrl)) {
                throw new Error(`Invalid package name or URL format: ${packageOrUrl}`);
            }
        }
        
        while (!introspectionResult || !introspectionResult.isValid) {
            // Ask for package name/URL
            if (!packageOrUrl) {
                while (!isValidPackageNameOrUrl(packageOrUrl)) {
                    try {
                        packageOrUrl = await getInput(rl, 'Enter your npm package name (e.g., @username/my-mcp-server) or HTTP/SSE URL: ', headlessOptions.packageOrUrl);
                        // Input validation working correctly
                        if (!isValidPackageNameOrUrl(packageOrUrl)) {
                            if (headlessOptions.headless) {
                                throw new Error(`Invalid package name or URL format: ${packageOrUrl}`);
                            }
                            console.log(chalk.red('Invalid package name or URL format. Please try again.'));
                            packageOrUrl = ''; // Reset to continue loop
                        }
                    } catch (err) {
                        if (headlessOptions.headless) {
                            throw err;
                        }
                        console.error(chalk.red('Error reading input:', err.message));
                        packageOrUrl = ''; // Reset to continue loop
                    }
                }
            }
            
            // In headless mode, we'll try introspection once and handle failures appropriately
            // Don't break here - let it continue to introspection
            
            packageOrUrl = packageOrUrl.trim();
            const isUrl = packageOrUrl.startsWith('http://') || packageOrUrl.startsWith('https://');
            const isGitHub = isUrl && packageOrUrl.includes('github.com/');
            
            // For GitHub repos, skip introspection and register directly
            if (isGitHub) {
                console.log(chalk.yellow('\n📦 GitHub repository detected. Registering without introspection...'));
                introspectionResult = {
                    isValid: true,
                    isGitHub: true,
                    isMinimal: true,
                    serverInfo: {
                        name: packageOrUrl.split('/').pop()?.replace('.git', '') || 'Unknown',
                        version: 'Unknown'
                    },
                    capabilities: {},
                    tools: [],
                    resources: [],
                    prompts: [],
                    useMcpRemote: false
                };
                break; // Exit the loop
            }
            
            // Introspect the MCP server
            console.log(chalk.blue('\n⏳ Connecting to MCP server and verifying capabilities...'));
            
            try {
                if (tempDir) {
                    // Clean up previous temp dir if it exists
                    try {
                        rmSync(tempDir, { recursive: true, force: true });
                    } catch (e) {}
                }
                tempDir = !isUrl ? mkdtempSync(join(tmpdir(), 'mcp-register-')) : null;
                introspectionResult = await introspectMCPServer(packageOrUrl, tempDir, null, headlessOptions);
                
                if (!introspectionResult.isValid) {
                    console.log(chalk.red(`❌ Cannot connect to MCP server: ${introspectionResult.error}`));
                    
                    // In headless mode, fail fast - don't register servers we can't connect to
                    if (headlessOptions.headless) {
                        throw new Error(`Cannot connect to MCP server: ${introspectionResult.error}`);
                    }
                } else if (introspectionResult.isValid && 
                          introspectionResult.tools.length === 0 && 
                          introspectionResult.resources.length === 0 && 
                          introspectionResult.prompts.length === 0) {
                    // Server connected but has no capabilities
                    console.log(chalk.yellow('⚠️  Server connected but reports no capabilities'));
                    
                    if (headlessOptions.headless) {
                        // In headless mode, skip servers with no capabilities
                        throw new Error('Server has no MCP capabilities');
                    }
                    
                    // Check if it's an authentication error
                    if (introspectionResult.error.includes('401') || introspectionResult.error.includes('Authentication required') || introspectionResult.error.includes('Unauthorized')) {
                        console.log(chalk.yellow('\nThis server requires authentication. Gathering available information...'));
                        
                        // Probe for minimal information
                        const probeInfo = await probeServerMinimal(packageOrUrl);
                        
                        // Display collected information
                        console.log(chalk.cyan('\n📊 Information gathered without authentication:\n'));
                        
                        if (probeInfo.metadata.title) {
                            console.log(`${chalk.bold('Page Title:')} ${probeInfo.metadata.title}`);
                        }
                        if (probeInfo.headers.allowMethods) {
                            console.log(`${chalk.bold('Allowed Methods:')} ${probeInfo.headers.allowMethods}`);
                        }
                        if (probeInfo.auth.details) {
                            console.log(`${chalk.bold('Auth Details:')} ${JSON.stringify(probeInfo.auth.details, null, 2)}`);
                        }
                        if (probeInfo.auth.wwwAuthenticate) {
                            console.log(`${chalk.bold('Auth Type:')} ${probeInfo.auth.wwwAuthenticate}`);
                        }
                        
                        // Ask if user has a token
                        const hasTokenAnswer = await getInput(rl, '\nDo you have an authentication token for this server? (y/n): ', headlessOptions.authToken ? 'y' : 'n');
                        
                        if (hasTokenAnswer.toLowerCase() === 'y') {
                            const token = await getInput(rl, 'Please enter your authentication token: ', headlessOptions.authToken);
                            
                            if (token) {
                                console.log(chalk.blue('\n⏳ Retrying with authentication token...'));
                                
                                // Retry introspection with token
                                const retryResult = await introspectMCPServer(packageOrUrl, tempDir, token, headlessOptions);
                                
                                if (retryResult.isValid) {
                                    introspectionResult = retryResult;
                                    console.log(chalk.green('✅ Successfully connected with authentication!'));
                                } else {
                                    console.log(chalk.red('❌ Authentication failed. Proceeding with limited information.'));
                                }
                            }
                        }
                        
                        // If still no valid introspection, proceed with manual/minimal registration
                        if (!introspectionResult.isValid) {
                            const addCapabilitiesAnswer = await getInput(rl, '\nWould you like to manually add capability information? (y/n): ', headlessOptions.manualCapabilities);
                            
                            if (addCapabilitiesAnswer.toLowerCase() === 'y') {
                                // Manual capability entry
                                introspectionResult = {
                                    isValid: true,
                                    isManual: true,
                                    serverInfo: {},
                                    capabilities: {},
                                    tools: [],
                                    resources: [],
                                    prompts: [],
                                    probeInfo: probeInfo,
                                    useMcpRemote: isUrl // Use mcp-remote for URL-based servers that require auth
                                };
                                console.log(chalk.yellow('\nPlease provide capability information...'));
                            } else {
                                // Minimal registration with no capabilities
                                introspectionResult = {
                                    isValid: true,
                                    isMinimal: true,
                                    serverInfo: {},
                                    capabilities: {},
                                    tools: [],
                                    resources: [],
                                    prompts: [],
                                    probeInfo: probeInfo,
                                    useMcpRemote: isUrl // Use mcp-remote for URL-based servers that require auth
                                };
                                console.log(chalk.yellow('\nProceeding with minimal registration (no capability details).'));
                            }
                        }
                    } else {
                        console.log(chalk.yellow('Please try a different package or URL.\n'));
                        packageOrUrl = ''; // Reset to ask again
                    }
                } else {
                    console.log(chalk.green('✅ Successfully connected to MCP server'));
                }
            } catch (introspectError) {
                console.log(chalk.red(`❌ Failed to introspect: ${introspectError.message}`));
                
                // In headless mode, exit with error
                if (headlessOptions.headless) {
                    throw introspectError;
                }
                
                // In interactive mode, allow retry
                console.log(chalk.yellow('Please try a different package or URL.\n'));
                packageOrUrl = ''; // Reset to ask again
                introspectionResult = null; // Reset to continue loop
            }
        }
        
        // Ensure we have a valid introspectionResult
        if (!introspectionResult) {
            introspectionResult = defaultIntrospectionResult;
        }
        
        // Check if this server already exists (for unverified updates)
        const hasSecret = !!process.env.MCP_REGISTRY_SECRET;
        let isUpdate = false;
        let existingServer = null;
        
        // Check if URL already exists in registry
        if (!hasSecret) {
            try {
                const checkResponse = await fetch(`${process.env.MCPFINDER_API_URL || 'https://mcpfinder.dev'}/api/v1/search?q=${encodeURIComponent(packageOrUrl)}&limit=1`);
                if (checkResponse.ok) {
                    const searchResult = await checkResponse.json();
                    // API returns array directly, not object with tools property
                    if (Array.isArray(searchResult) && searchResult.length > 0 && searchResult[0].url === packageOrUrl) {
                        isUpdate = true;
                        existingServer = searchResult[0];
                        
                        // Check if server is unanalyzed - allow full update for those
                        const isUnanalyzed = existingServer.tags && existingServer.tags.includes('unanalyzed');
                        if (isUnanalyzed) {
                            console.log(chalk.yellow('\n⚠️  This server was previously registered as unanalyzed. You can now provide full details.'));
                        } else {
                            console.log(chalk.yellow('\n⚠️  This server is already registered. Updating capabilities only...'));
                        }
                    }
                }
            } catch (e) {
                // Ignore search errors, proceed as new registration
            }
        }
        
        // Display discovered capabilities (skip for manual/minimal registration)
        if (introspectionResult && !introspectionResult.isManual && !introspectionResult.isMinimal) {
            console.log(chalk.cyan('\n📊 Discovered Capabilities:\n'));
            console.log(`${chalk.bold('Server:')} ${introspectionResult.serverInfo?.name || 'Unknown'}`);
            console.log(`${chalk.bold('Version:')} ${introspectionResult.serverInfo?.version || 'Unknown'}`);
            console.log(`${chalk.bold('Tools:')} ${introspectionResult.tools.length}`);
            console.log(`${chalk.bold('Resources:')} ${introspectionResult.resources.length}`);
            console.log(`${chalk.bold('Prompts:')} ${introspectionResult.prompts.length}`);
            
            if (introspectionResult.tools.length > 0) {
                console.log(chalk.gray('\nTools:'));
                introspectionResult.tools.slice(0, 5).forEach(tool => {
                    console.log(`  - ${tool.name}: ${tool.description || 'No description'}`);
                });
                if (introspectionResult.tools.length > 5) {
                    console.log(`  ... and ${introspectionResult.tools.length - 5} more`);
                }
            }
        }
        
        // Add a small delay to ensure output is flushed
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Collect additional information (skip for unauthorized updates)
        let description, tags = [], requiresApiKey = false, authInfo = {};
        
        // For manual/minimal registration of authenticated servers, always set auth required
        if (introspectionResult && (introspectionResult.isManual || introspectionResult.isMinimal)) {
            requiresApiKey = true;
        }
        
        if (!hasSecret && isUpdate && existingServer && !existingServer.tags?.includes('unanalyzed')) {
            // Unauthorized update for already-analyzed servers - skip all questions
            console.log(chalk.dim('\nSkipping questions for unauthorized update...'));
            description = introspectionResult?.serverInfo?.description || `MCP server: ${packageOrUrl}`;
            
            // Clean up existing tags to match API requirements
            if (existingServer.tags && Array.isArray(existingServer.tags)) {
                const cleanedTags = [];
                let hadInvalidTags = false;
                
                for (const tag of existingServer.tags) {
                    const cleanedTag = cleanTag(tag);
                    if (cleanedTag) {
                        if (!cleanedTags.includes(cleanedTag)) { // Avoid duplicates
                            cleanedTags.push(cleanedTag);
                        }
                        if (tag !== cleanedTag) {
                            hadInvalidTags = true;
                        }
                    } else if (tag) {
                        hadInvalidTags = true;
                    }
                }
                
                if (hadInvalidTags) {
                    console.log(chalk.yellow('Note: Some existing tags were cleaned to match API requirements'));
                }
                
                tags = cleanedTags;
            }
        } else {
            // New registration or authorized update - ask all questions
            // Ensure readline is still active (unless in headless mode)
            if (!rl && !headlessOptions.headless) {
                console.error(chalk.red('\nError: Readline interface was closed unexpectedly'));
                throw new Error('Readline interface closed');
            }
            const defaultDescription = introspectionResult?.serverInfo?.description || '';
            const descriptionPrompt = defaultDescription 
                ? `\nProvide a brief description of your MCP server [${defaultDescription}]: `
                : '\nProvide a brief description of your MCP server: ';
            
            try {
                description = await getInput(rl, descriptionPrompt, headlessOptions.description);
                if (!description) description = defaultDescription;
            } catch (questionError) {
                console.error(chalk.red('\nError reading input:', questionError.message));
                throw questionError;
            }
            
            let tagsInput;
            try {
                tagsInput = await getInput(rl, 'Enter tags (comma-separated, lowercase, letters/numbers/hyphens only, e.g., ai, github, productivity): ', headlessOptions.tags);
            } catch (questionError) {
                console.error(chalk.red('\nError reading input:', questionError.message));
                throw questionError;
            }
            
            // Parse and validate tags
            const rawTags = tagsInput.split(',').map(tag => tag.trim()).filter(Boolean);
            tags = [];
            
            for (const tag of rawTags) {
                const cleanedTag = cleanTag(tag);
                if (cleanedTag) {
                    if (!tags.includes(cleanedTag)) { // Avoid duplicates
                        tags.push(cleanedTag);
                    }
                    if (tag.toLowerCase() !== cleanedTag) {
                        console.log(chalk.yellow(`Info: Tag "${tag}" was cleaned to "${cleanedTag}"`));
                    }
                } else if (tag) {
                    console.log(chalk.yellow(`Warning: Skipping invalid tag "${tag}" (only lowercase letters, numbers, and hyphens allowed)`));
                }
            }
            
            if (tags.length === 0) {
                console.log(chalk.yellow('No valid tags provided. Using default tags.'));
                // Try to generate some tags from the package name or description
                if (packageOrUrl.includes('desktop')) tags.push('desktop');
                if (packageOrUrl.includes('ai') || description.toLowerCase().includes('ai')) tags.push('ai');
                if (packageOrUrl.includes('automation') || description.toLowerCase().includes('automation')) tags.push('automation');
                if (tags.length === 0) tags.push('utility'); // Default fallback
            }
            
            // Add automatic tags for minimal registration
            if (introspectionResult && introspectionResult.isMinimal && !introspectionResult.isGitHub) {
                if (!tags.includes('unanalyzed')) tags.push('unanalyzed');
                if (!tags.includes('auth-required')) tags.push('auth-required');
            }
            
            // Add tags for GitHub repos
            if (introspectionResult && introspectionResult.isGitHub) {
                if (!tags.includes('unanalyzed')) tags.push('unanalyzed');
                if (!tags.includes('github')) tags.push('github');
                if (!tags.includes('requires-installation')) tags.push('requires-installation');
            }
            
            // For servers that couldn't be introspected due to auth, requiresApiKey is already set
            // For normal servers, ask the user
            // Skip API key question for GitHub repos
            if (introspectionResult && !introspectionResult.isManual && !introspectionResult.isMinimal && !introspectionResult.isGitHub) {
                let requiresApiKeyAnswer;
                try {
                    requiresApiKeyAnswer = await getInput(rl, 'Does this server require an API key? (y/n): ', headlessOptions.requiresApiKey);
                } catch (questionError) {
                    console.error(chalk.red('\nError reading input:', questionError.message));
                    throw questionError;
                }
                requiresApiKey = typeof requiresApiKeyAnswer === 'boolean' ? requiresApiKeyAnswer : requiresApiKeyAnswer.toLowerCase() === 'y';
            }
            
            if (requiresApiKey) {
                if (introspectionResult && (introspectionResult.isManual || introspectionResult.isMinimal)) {
                    // Determine auth type from probe info or ask user
                    let authType = 'oauth'; // default
                    
                    if (introspectionResult.probeInfo?.auth?.wwwAuthenticate) {
                        const wwwAuth = introspectionResult.probeInfo.auth.wwwAuthenticate.toLowerCase();
                        if (wwwAuth.includes('bearer')) authType = 'oauth';
                        else if (wwwAuth.includes('basic')) authType = 'api-key';
                        else if (wwwAuth.includes('apikey')) authType = 'api-key';
                    }
                    
                    // For manual entry, let user override detected type
                    if (introspectionResult.isManual) {
                        const userAuthType = await getInput(rl, `Authentication type (oauth/api-key/custom) [${authType}]: `, headlessOptions.authType);
                        if (userAuthType) authType = userAuthType;
                        
                        // For manual registration, ask about capabilities
                        console.log(chalk.yellow('\nSince we couldn\'t introspect the server, please provide capability details:'));
                        const hasTools = await getInput(rl, 'Does this server provide tools? (y/n): ', headlessOptions.hasTools);
                        const hasResources = await getInput(rl, 'Does this server provide resources? (y/n): ', headlessOptions.hasResources);
                        const hasPrompts = await getInput(rl, 'Does this server provide prompts? (y/n): ', headlessOptions.hasPrompts);
                        
                        // Create placeholder capabilities
                        if (hasTools.toLowerCase() === 'y') {
                            introspectionResult.capabilities.tools = {};
                            introspectionResult.tools = [{ name: 'unknown', description: 'Capabilities will be available after authentication' }];
                        }
                        if (hasResources.toLowerCase() === 'y') {
                            introspectionResult.capabilities.resources = {};
                            introspectionResult.resources = [{ name: 'unknown', description: 'Capabilities will be available after authentication' }];
                        }
                        if (hasPrompts.toLowerCase() === 'y') {
                            introspectionResult.capabilities.prompts = {};
                            introspectionResult.prompts = [{ name: 'unknown', description: 'Capabilities will be available after authentication' }];
                        }
                    }
                    
                    authInfo.type = authType;
                    
                    // For minimal registration, use defaults based on probe info
                    if (introspectionResult.isMinimal) {
                        if (authType === 'oauth') {
                            authInfo.authInstructions = introspectionResult.probeInfo?.auth?.details?.help || 'OAuth authentication required';
                        } else if (authType === 'api-key') {
                            authInfo.keyName = 'API_KEY';
                            authInfo.authInstructions = 'Set the API key as an environment variable';
                        } else {
                            authInfo.authInstructions = 'Custom authentication required';
                        }
                    } else {
                        // For manual registration, ask for details
                        if (authType === 'oauth') {
                            authInfo.authInstructions = await getInput(rl, 'OAuth instructions (e.g., how to authenticate): ', headlessOptions.authInstructions) || 'OAuth authentication required';
                        } else if (authType === 'api-key') {
                            authInfo.keyName = await getInput(rl, 'Environment variable name for the API key: ', headlessOptions.keyName);
                            authInfo.authInstructions = await getInput(rl, 'Instructions for obtaining the API key: ', headlessOptions.authInstructions) || 'Set the API key as an environment variable';
                        } else {
                            authInfo.authInstructions = await getInput(rl, 'Authentication instructions: ', headlessOptions.authInstructions) || 'Custom authentication required';
                        }
                    }
                } else {
                    // Regular auth for introspected servers
                    authInfo.type = 'api-key'; // default for regular servers
                    authInfo.keyName = await getInput(rl, 'Environment variable name for the API key (e.g., GITHUB_TOKEN): ', headlessOptions.keyName);
                    authInfo.authInstructions = await getInput(rl, 'Instructions for obtaining the API key: ', headlessOptions.authInstructions) || 'Set the API key as an environment variable';
                }
            }
        }
        
        // Generate manifest
        const manifest = generateManifest(packageOrUrl, introspectionResult, {
            description: description || introspectionResult.serverInfo?.description || 
                        (introspectionResult.isMinimal ? 'Authentication required - capabilities unknown' : undefined),
            tags,
            requiresApiKey,
            isMinimal: introspectionResult.isMinimal,
            useMcpRemote: introspectionResult.useMcpRemote,
            ...authInfo
        });
        
        // For unauthorized updates of already-analyzed servers, skip manifest preview and confirmation
        if (!hasSecret && isUpdate && existingServer && !existingServer.tags?.includes('unanalyzed')) {
            console.log(chalk.dim('\nSubmitting capability updates...'));
        } else {
            // Show manifest preview
            console.log(chalk.cyan('\n📄 Generated Manifest:\n'));
            console.log(chalk.gray(JSON.stringify(manifest, null, 2)));
            
            // Confirm submission
            const confirmAnswer = await getInput(rl, '\nSubmit this manifest to MCPfinder registry? (y/n): ', headlessOptions.confirm);
            if (confirmAnswer.toLowerCase() !== 'y') {
                console.log(chalk.yellow('\nRegistration cancelled'));
                return;
            }
        }
        
        // Submit to registry
        console.log(chalk.blue('\n⏳ Submitting to MCPfinder registry...'));
        
        try {
            const result = await submitToRegistry(manifest);
            console.log(chalk.green('✅ Successfully registered!'));
            
            const hasSecret = !!process.env.MCP_REGISTRY_SECRET;
            
            if (hasSecret) {
                console.log(chalk.green('\n✅ Your MCP server has been registered and verified!'));
            } else if (result.operation === 'updated') {
                console.log(chalk.green('\n✅ Successfully updated capabilities!'));
                console.log(chalk.dim('Note: Only tools/capabilities were updated.'));
                console.log(chalk.dim('Name, description, and tags remain unchanged.'));
            } else {
                console.log(chalk.yellow('\n⚠️  Your MCP server has been registered (unverified)'));
                console.log(chalk.dim('Note: This registration is unverified. To get verified status,'));
                console.log(chalk.dim('set MCP_REGISTRY_SECRET and register again.'));
            }
            
            console.log(`${chalk.bold('ID:')} ${result.id}`);
            console.log(`${chalk.bold('Name:')} ${manifest.name}`);
            console.log(`${chalk.bold('Operation:')} ${result.operation || 'created'}`)
            
        } catch (submitError) {
            console.log(chalk.red('❌ Registration failed'));
            console.error(chalk.red(`\n❌ Error: ${submitError.message}`));
        }
        
    } catch (error) {
        if (error.message === 'Input interrupted') {
            console.log(chalk.yellow('\nRegistration cancelled by user'));
        } else {
            console.error(chalk.red(`\nUnexpected error: ${error.message}`));
            console.error(chalk.dim('Stack trace:', error.stack));
        }
        process.exit(1);
    } finally {
        if (rl) {
            rl.close();
        }
        
        // Cleanup temp directory
        if (tempDir) {
            try {
                rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    }
}

// Allow direct invocation
if (import.meta.url === `file://${process.argv[1]}`) {
    runRegister().catch(err => {
        console.error("Registration failed:", err);
        process.exit(1);
    });
}