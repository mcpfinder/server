#!/usr/bin/env node

import readline from 'readline';
import fetch from 'node-fetch';

// Function to create a readline interface
function createPromptInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

// Function to ask a question and get the answer
function askQuestion(rl, query) {
    return new Promise(resolve => rl.question(query, resolve));
}

// Function to validate package name/URL
function isValidPackageName(packageName) {
    // Simple validation - can be enhanced based on requirements
    return packageName && packageName.trim().length > 0;
}

// Function to validate Stripe Account ID
function isValidStripeAccountId(accountId) {
    // Simple validation for Stripe account ID (starts with 'acct_')
    return accountId && /^acct_\w+$/.test(accountId);
}

// Main registration function
export async function runRegister() {
    console.log("=== MCP Server Registration ===");
    console.log("This will register your MCP server package with the registry.");
    
    const rl = createPromptInterface();
    
    try {
        // Ask for package name/URL
        let packageName = '';
        while (!isValidPackageName(packageName)) {
            packageName = await askQuestion(rl, "Enter your package name or URL: ");
            if (!isValidPackageName(packageName)) {
                console.log("Invalid package name. Please try again.");
            }
        }
        
        // Ask for Stripe account ID
        let stripeAccountId = '';
        while (!isValidStripeAccountId(stripeAccountId)) {
            stripeAccountId = await askQuestion(rl, "Enter your Stripe account ID (starts with 'acct_'): ");
            if (!isValidStripeAccountId(stripeAccountId)) {
                console.log("Invalid Stripe account ID. It should start with 'acct_'. Please try again.");
            }
        }
        
        console.log("\nProcessing registration...");
        
        // Mock API call - in a real implementation, this would send data to the registry
        console.log(`Package: ${packageName}`);
        console.log(`Stripe Account: ${stripeAccountId}`);
        
        // Success message
        console.log("\n✅ Please contact lucas@mcpfinder.dev to get your MCP server registered with the registry. Process will be automated soon!");
        // console.log("Your MCP server has been registered with the registry.");
        // console.log("Users can now find and install your package using the MCP Finder.");
        
    } catch (error) {
        console.error("An error occurred during registration:", error);
        process.exit(1);
    } finally {
        rl.close();
    }
}

// Allow direct invocation
if (import.meta.url === `file://${process.argv[1]}`) {
    runRegister().catch(err => {
        console.error("Registration failed:", err);
        process.exit(1);
    });
} 