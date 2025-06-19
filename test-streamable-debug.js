#!/usr/bin/env node

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJsdWthc3pAd2VhcmZpdHMuY29tIiwiZW1haWwiOiJsdWthc3pAd2VhcmZpdHMuY29tIiwibmFtZSI6IsWBdWthc3ogUnplcGVja2kgKFdFQVJGSVRTKSIsImlhdCI6MTc1MDM3MTE0NCwiZXhwIjoxNzUwNDU3NTQ0LCJtY3AiOnsidmVyc2lvbiI6IjEuMCIsInBlcm1pc3Npb25zIjpbInJlYWQiLCJ3cml0ZSJdLCJjbGllbnQiOiJjbGF1ZGUtY29kZSJ9fQ.YV7PKXhmrUKpeqELJVGlUYlANsZ6SSY_7TrcyyJ57vc';

async function test() {
    console.log('Testing StreamableHTTP transport directly...\n');
    
    const url = new URL('https://whenmeet.me/api/mcp');
    const transport = new StreamableHTTPClientTransport(url);
    
    // Set auth provider
    transport._authProvider = {
        tokens: async () => ({
            access_token: token,
            token_type: 'Bearer'
        })
    };
    
    try {
        console.log('Sending initialize request...');
        
        // Try to send a message directly
        const response = await transport.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: {
                    name: 'mcpfinder-test',
                    version: '1.0.0'
                }
            }
        });
        
        console.log('Response:', JSON.stringify(response, null, 2));
        
    } catch (error) {
        console.error('Error:', error.message);
        
        // Try to get more details about the error
        if (error.issues) {
            console.error('\nZod validation issues:');
            error.issues.forEach(issue => {
                console.error('- Path:', issue.path);
                console.error('  Message:', issue.message);
                console.error('  Code:', issue.code);
            });
        }
    }
}

test();