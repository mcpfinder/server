#!/usr/bin/env node

import readline from 'readline';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import crypto from 'crypto';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import ora from 'ora';
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
        
        rl.question(query, (answer) => {
            clearTimeout(timeout);
            const trimmedAnswer = answer ? answer.trim() : answer;
            console.log(chalk.dim(`Debug: Raw: '${answer}' -> Trimmed: '${trimmedAnswer}' (length: ${answer?.length} -> ${trimmedAnswer?.length})`));
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
            // HTTP/SSE transport
            // If URL already ends with /sse, use it as is
            // Otherwise, append /sse to the base URL
            let sseUrl;
            if (packageOrUrl.endsWith('/sse')) {
                sseUrl = new URL(packageOrUrl);
            } else {
                const baseUrl = new URL(packageOrUrl);
                sseUrl = new URL('/sse', baseUrl);
            }
            transport = new SSEClientTransport(sseUrl);
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
        console.error(chalk.dim('Debug: Introspection error:', error.message));
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
    
    if (!secret) {
        throw new Error('MCP_REGISTRY_SECRET environment variable is required');
    }
    
    // Create HMAC signature
    const timestamp = Date.now();
    const payload = JSON.stringify(manifest);
    const message = `${timestamp}.${payload}`;
    const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');
    
    const response = await fetch(`${apiUrl}/api/v1/register`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-MCP-Signature': signature,
            'X-MCP-Timestamp': timestamp.toString()
        },
        body: payload
    });
    
    const result = await response.json();
    
    if (!response.ok) {
        throw new Error(result.error || 'Registration failed');
    }
    
    return result;
}

// Main registration function
export async function runRegister() {
    console.log(chalk.bold.blue('\n📋 Register Your MCP Server with MCPfinder\n'));
    
    // Ensure stdin doesn't close prematurely
    process.stdin.resume();
    process.stdin.setRawMode?.(false);
    
    const rl = createPromptInterface();
    
    // Add line event listener as backup for paste issues
    rl.on('line', (input) => {
        console.log(chalk.dim(`Debug: Line event received: '${input}'`));
    });
    let tempDir = null;
    
    try {
        // Keep asking for package name/URL until we get a valid MCP server
        let packageOrUrl = '';
        let introspectionResult = null;
        
        while (!introspectionResult || !introspectionResult.isValid) {
            // Ask for package name/URL
            while (!isValidPackageNameOrUrl(packageOrUrl)) {
                packageOrUrl = await askQuestion(rl, 'Enter your npm package name (e.g., @username/my-mcp-server) or HTTP/SSE URL: ');
                console.log(chalk.dim(`Debug: Got input: '${packageOrUrl}' (valid: ${isValidPackageNameOrUrl(packageOrUrl)})`));
                if (!isValidPackageNameOrUrl(packageOrUrl)) {
                    console.log(chalk.red('Invalid package name or URL format. Please try again.'));
                }
            }
            
            packageOrUrl = packageOrUrl.trim();
            const isUrl = packageOrUrl.startsWith('http://') || packageOrUrl.startsWith('https://');
            
            // Introspect the MCP server
            const spinner = ora('Connecting to MCP server and verifying capabilities...').start();
            
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
                    spinner.fail(`Not a valid MCP server: ${introspectionResult.error}`);
                    console.log(chalk.yellow('Please try a different package or URL.\n'));
                    packageOrUrl = ''; // Reset to ask again
                } else {
                    spinner.succeed('Successfully connected to MCP server');
                }
            } catch (introspectError) {
                spinner.fail(`Failed to introspect: ${introspectError.message}`);
                console.error(chalk.dim('Debug: Full error:', introspectError));
                console.log(chalk.yellow('Please try a different package or URL.\n'));
                packageOrUrl = ''; // Reset to ask again
                introspectionResult = null; // Reset to continue loop
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
        
        // Collect additional information
        // Ensure readline is still active
        if (!rl) {
            console.error(chalk.red('\nError: Readline interface was closed unexpectedly'));
            throw new Error('Readline interface closed');
        }
        const defaultDescription = introspectionResult.serverInfo?.description || '';
        const descriptionPrompt = defaultDescription 
            ? `\nProvide a brief description of your MCP server [${defaultDescription}]: `
            : '\nProvide a brief description of your MCP server: ';
        
        let description;
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
        
        const tags = tagsInput.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean);
        const requiresApiKey = requiresApiKeyAnswer.toLowerCase() === 'y';
        
        let authInfo = {};
        if (requiresApiKey) {
            authInfo.keyName = await askQuestion(rl, 'Environment variable name for the API key (e.g., GITHUB_TOKEN): ');
            authInfo.authInstructions = await askQuestion(rl, 'Instructions for obtaining the API key: ') || 'Set the API key as an environment variable';
        }
        
        // Generate manifest
        const manifest = generateManifest(packageOrUrl, introspectionResult, {
            description: description || introspectionResult.serverInfo?.description,
            tags,
            requiresApiKey,
            ...authInfo
        });
        
        // Show manifest preview
        console.log(chalk.cyan('\n📄 Generated Manifest:\n'));
        console.log(chalk.gray(JSON.stringify(manifest, null, 2)));
        
        // Confirm submission
        const confirmAnswer = await askQuestion(rl, '\nSubmit this manifest to MCPfinder registry? (y/n): ');
        if (confirmAnswer.toLowerCase() !== 'y') {
            console.log(chalk.yellow('\nRegistration cancelled'));
            return;
        }
        
        // Submit to registry
        const submitSpinner = ora('Submitting to MCPfinder registry...').start();
        
        try {
            const result = await submitToRegistry(manifest);
            submitSpinner.succeed('Successfully registered!');
            
            console.log(chalk.green('\n✅ Your MCP server has been registered!'));
            console.log(`${chalk.bold('ID:')} ${result.id}`);
            console.log(`${chalk.bold('Name:')} ${result.manifest.name}`);
            console.log(`\nView your server at: ${chalk.cyan(`https://mcpfinder.dev/tools/${result.id}`)}`);
            
        } catch (submitError) {
            submitSpinner.fail('Registration failed');
            
            if (submitError.message.includes('MCP_REGISTRY_SECRET')) {
                console.error(chalk.red('\n❌ Authentication required'));
                console.log('\nTo register servers, you need to set the MCP_REGISTRY_SECRET environment variable.');
                console.log('Please contact lucas@mcpfinder.dev to obtain a registration secret.');
            } else {
                console.error(chalk.red(`\n❌ Error: ${submitError.message}`));
            }
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