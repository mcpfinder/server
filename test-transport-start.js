#!/usr/bin/env node

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJsdWthc3pAd2VhcmZpdHMuY29tIiwiZW1haWwiOiJsdWthc3pAd2VhcmZpdHMuY29tIiwibmFtZSI6IsWBdWthc3ogUnplcGVja2kgKFdFQVJGSVRTKSIsImlhdCI6MTc1MDM3MTE0NCwiZXhwIjoxNzUwNDU3NTQ0LCJtY3AiOnsidmVyc2lvbiI6IjEuMCIsInBlcm1pc3Npb25zIjpbInJlYWQiLCJ3cml0ZSJdLCJjbGllbnQiOiJjbGF1ZGUtY29kZSJ9fQ.YV7PKXhmrUKpeqELJVGlUYlANsZ6SSY_7TrcyyJ57vc';

async function test() {
    console.log('Testing transport start sequence...\n');
    
    const url = new URL('https://whenmeet.me/api/mcp');
    const transport = new StreamableHTTPClientTransport(url);
    
    // Set auth provider
    transport._authProvider = {
        tokens: async () => ({
            access_token: token,
            token_type: 'Bearer'
        })
    };
    
    // Set up message handler
    transport.onmessage = (message) => {
        console.log('Received message:', JSON.stringify(message, null, 2));
    };
    
    transport.onerror = (error) => {
        console.error('Transport error:', error);
    };
    
    transport.onclose = () => {
        console.log('Transport closed');
    };
    
    try {
        console.log('Starting transport...');
        await transport.start();
        console.log('Transport started successfully');
        
        // Now try to send initialize
        console.log('\nSending initialize...');
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
        
        console.log('Initialize response:', response);
        
        // Wait a bit for any messages
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        await transport.close();
    } catch (error) {
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
    }
}

test();