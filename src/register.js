#!/usr/bin/env node

import readline from 'readline';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHttpClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

// Function to introspect MCP server
async function introspectMCPServer(packageOrUrl, tempDir = null) {
    const isUrl = packageOrUrl.startsWith('http://') || packageOrUrl.startsWith('https://');
    let transport;
    let client;
    
    try {
        if (isUrl) {
            const url = new URL(packageOrUrl);
            
            // Check if URL ends with /sse - use deprecated SSE transport
            if (packageOrUrl.endsWith('/sse')) {
                // Use SSE transport for legacy SSE endpoints
                transport = new SSEClientTransport(url);
            } else {
                // Use StreamableHttp transport for modern HTTP endpoints
                transport = new StreamableHttpClientTransport(url);
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
        client = new Client({ name: 'mcpfinder-register', version: '1.0.0' });
        await client.connect(transport);
        
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
    }
}

// Function to generate manifest
function generateManifest(packageOrUrl, introspectionResult, additionalInfo = {}) {
    const { serverInfo, tools, resources, prompts } = introspectionResult;
    
    // Build capabilities array
    const capabilities = [];
    
    // Add tools
    tools.forEach(tool => {
        capabilities.push({
            name: tool.name,
            type: 'tool',
            description: tool.description || ''
        });
    });
    
    // Add resources
    resources.forEach(resource => {
        capabilities.push({
            name: resource.name || resource.uri,
            type: 'resource',
            description: resource.description || ''
        });
    });
    
    // Add prompts
    prompts.forEach(prompt => {
        capabilities.push({
            name: prompt.name,
            type: 'prompt',
            description: prompt.description || ''
        });
    });
    
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
    
    // Add auth if API key mentioned
    if (additionalInfo.requiresApiKey) {
        manifest.auth = {
            type: 'api-key',
            instructions: additionalInfo.authInstructions || 'Set the API key as an environment variable',
            key_name: additionalInfo.keyName
        };
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
    
    const result = await response.json();
    
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
                    console.log(chalk.red(`❌ Not a valid MCP server: ${introspectionResult.error}`));
                    console.log(chalk.yellow('Please try a different package or URL.\n'));
                    packageOrUrl = ''; // Reset to ask again
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
        
        // Check if URL already exists in registry
        if (!hasSecret) {
            try {
                const checkResponse = await fetch(`${process.env.MCPFINDER_API_URL || 'https://mcpfinder.dev'}/api/v1/search?q=${encodeURIComponent(packageOrUrl)}&limit=1`);
                if (checkResponse.ok) {
                    const searchResult = await checkResponse.json();
                    // API returns array directly, not object with tools property
                    if (Array.isArray(searchResult) && searchResult.length > 0 && searchResult[0].url === packageOrUrl) {
                        isUpdate = true;
                        console.log(chalk.yellow('\n⚠️  This server is already registered. Updating capabilities only...'));
                    }
                }
            } catch (e) {
                // Ignore search errors, proceed as new registration
            }
        }
        
        // Display discovered capabilities
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
        
        // Add a small delay to ensure output is flushed
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Collect additional information (skip for unauthorized updates)
        let description, tags = [], requiresApiKey = false, authInfo = {};
        
        if (!hasSecret && isUpdate) {
            // Unauthorized update - skip all questions
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
            
            let tagsInput, requiresApiKeyAnswer;
            try {
                tagsInput = await askQuestion(rl, 'Enter tags (comma-separated, e.g., ai, github, productivity): ');
                requiresApiKeyAnswer = await askQuestion(rl, 'Does this server require an API key? (y/n): ');
            } catch (questionError) {
                console.error(chalk.red('\nError reading input:', questionError.message));
                throw questionError;
            }
            
            tags = tagsInput.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean);
            requiresApiKey = requiresApiKeyAnswer.toLowerCase() === 'y';
            
            if (requiresApiKey) {
                authInfo.keyName = await askQuestion(rl, 'Environment variable name for the API key (e.g., GITHUB_TOKEN): ');
                authInfo.authInstructions = await askQuestion(rl, 'Instructions for obtaining the API key: ') || 'Set the API key as an environment variable';
            }
        }
        
        // Generate manifest
        const manifest = generateManifest(packageOrUrl, introspectionResult, {
            description: description || introspectionResult.serverInfo?.description,
            tags,
            requiresApiKey,
            ...authInfo
        });
        
        // For unauthorized updates, skip manifest preview and confirmation
        if (!hasSecret && isUpdate) {
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