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
    return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(trimmed);
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
async function introspectMCPServer(packageOrUrl, tempDir = null, authToken = null) {
    const isUrl = packageOrUrl.startsWith('http://') || packageOrUrl.startsWith('https://');
    let transport;
    let client;
    let originalFetch = null;
    
    try {
        if (isUrl) {
            const url = new URL(packageOrUrl);
            
            // Check if URL ends with /sse - use deprecated SSE transport
            if (packageOrUrl.endsWith('/sse')) {
                // Use SSE transport for legacy SSE endpoints
                transport = new SSEClientTransport(url);
            } else {
                // Use StreamableHTTP transport for modern HTTP endpoints
                transport = new StreamableHTTPClientTransport(url);
            }
        } else {
            // STDIO transport for npm packages
            const actualTempDir = tempDir || mkdtempSync(join(tmpdir(), 'mcp-register-'));
            transport = new StdioClientTransport({
                command: 'npx',
                args: ['-y', packageOrUrl],
                env: process.env,
                stderr: 'pipe',
                cwd: actualTempDir
            });
        }
        
        // Connect to the MCP server
        const clientOptions = { name: 'mcpfinder-register', version: '1.0.0' };
        
        // Store original fetch for cleanup
        let originalFetch = null;
        
        // Add auth token if provided
        if (authToken && isUrl) {
            // Create auth provider for OAuth-style authentication
            transport._authProvider = {
                tokens: async () => ({
                    access_token: authToken,
                    token_type: 'Bearer'
                })
            };
            
            // Override the global fetch to add Authorization header as fallback
            originalFetch = global.fetch;
            
            // Replace global fetch temporarily
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
            await client.connect(transport);
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
    const installation = isUrl ? undefined : {
        command: 'npx',
        args: ['-y', packageOrUrl]
    };
    
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
export async function runRegister() {
    console.log(chalk.bold.blue('\n📋 Register Your MCP Server with MCPfinder\n'));
    
    // Ensure stdin doesn't close prematurely
    process.stdin.resume();
    // Ensure we're not in raw mode which can interfere with readline
    if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
    }
    
    const rl = createPromptInterface();
    
    // Set encoding to handle paste properly
    rl.input.setEncoding('utf8');
    
    // Remove any existing line event listeners to prevent issues
    rl.removeAllListeners('line');
    let tempDir = null;
    
    try {
        // Keep asking for package name/URL until we get a valid MCP server
        let packageOrUrl = '';
        let introspectionResult = null;
        
        while (!introspectionResult || !introspectionResult.isValid) {
            // Ask for package name/URL
            packageOrUrl = ''; // Reset before asking
            while (!isValidPackageNameOrUrl(packageOrUrl)) {
                try {
                    packageOrUrl = await askQuestion(rl, 'Enter your npm package name (e.g., @username/my-mcp-server) or HTTP/SSE URL: ');
                    // Input validation working correctly
                    if (!isValidPackageNameOrUrl(packageOrUrl)) {
                        console.log(chalk.red('Invalid package name or URL format. Please try again.'));
                        packageOrUrl = ''; // Reset to continue loop
                    }
                } catch (err) {
                    console.error(chalk.red('Error reading input:', err.message));
                    packageOrUrl = ''; // Reset to continue loop
                }
            }
            
            packageOrUrl = packageOrUrl.trim();
            const isUrl = packageOrUrl.startsWith('http://') || packageOrUrl.startsWith('https://');
            
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
                introspectionResult = await introspectMCPServer(packageOrUrl, tempDir);
                
                if (!introspectionResult.isValid) {
                    console.log(chalk.red(`❌ Cannot connect to MCP server: ${introspectionResult.error}`));
                    
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
                        const hasTokenAnswer = await askQuestion(rl, '\nDo you have an authentication token for this server? (y/n): ');
                        
                        if (hasTokenAnswer.toLowerCase() === 'y') {
                            const token = await askQuestion(rl, 'Please enter your authentication token: ');
                            
                            if (token) {
                                console.log(chalk.blue('\n⏳ Retrying with authentication token...'));
                                
                                // Retry introspection with token
                                const retryResult = await introspectMCPServer(packageOrUrl, tempDir, token);
                                
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
                            const addCapabilitiesAnswer = await askQuestion(rl, '\nWould you like to manually add capability information? (y/n): ');
                            
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
                                    probeInfo: probeInfo
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
                                    probeInfo: probeInfo
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
                // Full error details available if needed
                console.log(chalk.yellow('Please try a different package or URL.\n'));
                packageOrUrl = ''; // Reset to ask again
                introspectionResult = null; // Reset to continue loop
            }
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
        if (!introspectionResult.isManual && !introspectionResult.isMinimal) {
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
        if (introspectionResult.isManual || introspectionResult.isMinimal) {
            requiresApiKey = true;
        }
        
        if (!hasSecret && isUpdate && existingServer && !existingServer.tags?.includes('unanalyzed')) {
            // Unauthorized update for already-analyzed servers - skip all questions
            console.log(chalk.dim('\nSkipping questions for unauthorized update...'));
            description = introspectionResult.serverInfo?.description || `MCP server: ${packageOrUrl}`;
        } else {
            // New registration or authorized update - ask all questions
            // Ensure readline is still active
            if (!rl) {
                console.error(chalk.red('\nError: Readline interface was closed unexpectedly'));
                throw new Error('Readline interface closed');
            }
            const defaultDescription = introspectionResult.serverInfo?.description || '';
            const descriptionPrompt = defaultDescription 
                ? `\nProvide a brief description of your MCP server [${defaultDescription}]: `
                : '\nProvide a brief description of your MCP server: ';
            
            try {
                description = await askQuestion(rl, descriptionPrompt);
                if (!description) description = defaultDescription;
            } catch (questionError) {
                console.error(chalk.red('\nError reading input:', questionError.message));
                throw questionError;
            }
            
            let tagsInput;
            try {
                tagsInput = await askQuestion(rl, 'Enter tags (comma-separated, e.g., ai, github, productivity): ');
            } catch (questionError) {
                console.error(chalk.red('\nError reading input:', questionError.message));
                throw questionError;
            }
            
            tags = tagsInput.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean);
            
            // Add automatic tags for minimal registration
            if (introspectionResult.isMinimal) {
                if (!tags.includes('unanalyzed')) tags.push('unanalyzed');
                if (!tags.includes('auth-required')) tags.push('auth-required');
            }
            
            // For servers that couldn't be introspected due to auth, requiresApiKey is already set
            // For normal servers, ask the user
            if (!introspectionResult.isManual && !introspectionResult.isMinimal) {
                let requiresApiKeyAnswer;
                try {
                    requiresApiKeyAnswer = await askQuestion(rl, 'Does this server require an API key? (y/n): ');
                } catch (questionError) {
                    console.error(chalk.red('\nError reading input:', questionError.message));
                    throw questionError;
                }
                requiresApiKey = requiresApiKeyAnswer.toLowerCase() === 'y';
            }
            
            if (requiresApiKey) {
                if (introspectionResult.isManual || introspectionResult.isMinimal) {
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
                        const userAuthType = await askQuestion(rl, `Authentication type (oauth/api-key/custom) [${authType}]: `);
                        if (userAuthType) authType = userAuthType;
                        
                        // For manual registration, ask about capabilities
                        console.log(chalk.yellow('\nSince we couldn\'t introspect the server, please provide capability details:'));
                        const hasTools = await askQuestion(rl, 'Does this server provide tools? (y/n): ');
                        const hasResources = await askQuestion(rl, 'Does this server provide resources? (y/n): ');
                        const hasPrompts = await askQuestion(rl, 'Does this server provide prompts? (y/n): ');
                        
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
                            authInfo.authInstructions = await askQuestion(rl, 'OAuth instructions (e.g., how to authenticate): ') || 'OAuth authentication required';
                        } else if (authType === 'api-key') {
                            authInfo.keyName = await askQuestion(rl, 'Environment variable name for the API key: ');
                            authInfo.authInstructions = await askQuestion(rl, 'Instructions for obtaining the API key: ') || 'Set the API key as an environment variable';
                        } else {
                            authInfo.authInstructions = await askQuestion(rl, 'Authentication instructions: ') || 'Custom authentication required';
                        }
                    }
                } else {
                    // Regular auth for introspected servers
                    authInfo.type = 'api-key'; // default for regular servers
                    authInfo.keyName = await askQuestion(rl, 'Environment variable name for the API key (e.g., GITHUB_TOKEN): ');
                    authInfo.authInstructions = await askQuestion(rl, 'Instructions for obtaining the API key: ') || 'Set the API key as an environment variable';
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
            const confirmAnswer = await askQuestion(rl, '\nSubmit this manifest to MCPfinder registry? (y/n): ');
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
        rl.close();
        
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