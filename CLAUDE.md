# MCPfinder Server CLI Documentation

## Overview
MCPfinder Server is a CLI tool for discovering and registering MCP (Model Context Protocol) servers with the MCPfinder registry.

## Registration Command

The `register` command allows users to submit MCP servers to the MCPfinder registry.

### Usage
```bash
npx -y @mcpfinder/server register
```

### Features

1. **Automatic Introspection**: Connects to the MCP server to discover capabilities
2. **Multi-Transport Support**: 
   - STDIO for npm packages
   - SSE transport for URLs ending with `/sse`
   - HTTP transport for standard MCP endpoints
   - Auto-detection of transport type via Content-Type header
3. **Authentication Support**: Handles authenticated servers with multiple options
4. **Unverified Registration**: Allows registration without authentication token

### Authentication Handling

The registration tool supports both authenticated and unauthenticated servers:

#### For Open Servers
- Direct introspection and registration
- Automatically discovers tools, resources, and prompts

#### For Authenticated Servers
When a server requires authentication (returns 401), the tool offers three paths:

1. **Retry with Token**: 
   - User provides authentication token
   - Supports Bearer token authentication
   - Both OAuth-style auth providers and direct header injection

2. **Manual Registration**:
   - User manually specifies if server has tools/resources/prompts
   - Creates placeholder entries marked as "unknown"
   - Useful when auth token is not available

3. **Minimal Registration**:
   - Registers with "unanalyzed" and "auth-required" tags
   - Single capability entry indicating auth is required
   - Can be fully updated later (even without auth token)

### Known Issues

1. **SSE Origin Validation**: Some SSE servers may fail with "Endpoint origin does not match connection origin" if they return mismatched protocols (http vs https). Use manual registration for these servers.

2. **Token Format**: The tool expects Bearer tokens. Other authentication methods may require manual registration.

### API Integration

The registration command submits to:
- Production: `https://mcpfinder.dev/api/v1/register`
- Can be overridden with `MCPFINDER_API_URL` environment variable

Authentication with the registry API:
- Uses HMAC signature with `MCP_REGISTRY_SECRET`
- Without secret, registrations are marked as "unverified"
- Unverified registrations can only update capabilities

### Testing Commands

```bash
# Test with local server
npm run dev

# Test registration
node src/register.js

# With custom API endpoint
MCPFINDER_API_URL=http://localhost:8787 node src/register.js

# With registry authentication
MCP_REGISTRY_SECRET=your-secret node src/register.js
```

## Other Commands

- `/help` - Show help information
- `/mcp` - Start interactive MCP session
- `/search <query>` - Search for MCP servers
- `/trending` - Show trending servers

## Development Notes

- Uses readline for interactive CLI
- No spinner animations (causes readline conflicts)
- Supports both ESM and CommonJS
- Node.js 18+ required