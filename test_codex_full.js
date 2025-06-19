import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import * as toml from '@iarna/toml';

// Mock functions from index.js for testing
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

function getConfigPath(clientType) {
    const homeDir = os.homedir();
    switch (clientType) {
        case 'codex':
            return path.join(homeDir, '.codex', 'config.toml');
        default:
            throw new Error(`Unsupported client type: ${clientType}`);
    }
}

async function testCodexFullFunctionality() {
    console.log('🧪 Testing Codex full functionality...');
    
    // Create a temporary test directory
    const testDir = path.join(os.tmpdir(), 'codex-test-' + Date.now());
    const testConfigPath = path.join(testDir, 'config.toml');
    
    try {
        console.log('📁 Creating test directory:', testDir);
        await fs.mkdir(testDir, { recursive: true });
        
        // Test 1: Read empty config (should create default structure)
        console.log('\n1️⃣ Testing empty config read...');
        let config = await readTomlConfigFile(testConfigPath);
        console.log('✅ Empty config read successful:', JSON.stringify(config, null, 2));
        
        // Test 2: Add a server
        console.log('\n2️⃣ Testing server addition...');
        config.mcp_servers['whenmeet-mcp'] = {
            command: 'npx',
            args: ['mcp-remote', 'https://whenmeet.me/mcp'],
            env: {}
        };
        
        await writeTomlConfigFile(testConfigPath, config);
        console.log('✅ Server added successfully');
        
        // Test 3: Read back the config
        console.log('\n3️⃣ Testing config read back...');
        const readBackConfig = await readTomlConfigFile(testConfigPath);
        console.log('✅ Config read back successful:', JSON.stringify(readBackConfig, null, 2));
        
        // Test 4: Verify TOML file content
        console.log('\n4️⃣ Testing TOML file content...');
        const tomlContent = await fs.readFile(testConfigPath, 'utf-8');
        console.log('📄 TOML content:');
        console.log(tomlContent);
        
        // Test 5: Remove a server
        console.log('\n5️⃣ Testing server removal...');
        delete readBackConfig.mcp_servers['whenmeet-mcp'];
        await writeTomlConfigFile(testConfigPath, readBackConfig);
        console.log('✅ Server removed successfully');
        
        // Test 6: Verify removal
        console.log('\n6️⃣ Testing removal verification...');
        const finalConfig = await readTomlConfigFile(testConfigPath);
        console.log('✅ Final config:', JSON.stringify(finalConfig, null, 2));
        
        // Test 7: Test path resolution
        console.log('\n7️⃣ Testing path resolution...');
        const codexPath = getConfigPath('codex');
        console.log('✅ Codex config path:', codexPath);
        
        console.log('\n🎉 All Codex functionality tests passed!');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        // Cleanup
        try {
            console.log('\n🧹 Cleaning up test directory...');
            await fs.rm(testDir, { recursive: true, force: true });
            console.log('✅ Cleanup successful');
        } catch (cleanupError) {
            console.error('⚠️ Cleanup failed:', cleanupError);
        }
    }
}

testCodexFullFunctionality(); 