# MCPfinder Server CLI Documentation

## Overview
MCPfinder Server is a CLI tool for discovering and registering MCP (Model Context Protocol) servers with the MCPfinder registry.

## Registration Command

The `register` command allows users to submit MCP servers to the MCPfinder registry.

### Headless Mode

The registration command now supports headless (automated) operation for batch processing and automation:

```bash
# Headless registration with all parameters
node index.js register package-name --headless --description "My MCP server" --tags "ai,productivity" --auth-token "your-token"

# Minimal headless registration (uses defaults)
node index.js register @myorg/mcp-server --headless

# Register a Python package
node index.js register mcp-python-server --headless --use-uvx --description "Python MCP server"
```

#### Headless Parameters

- `--headless` - Enable headless mode (no interactive prompts)
- `--description "text"` - Server description
- `--tags "tag1,tag2"` - Comma-separated tags
- `--auth-token "token"` - Authentication token if server requires auth
- `--requires-api-key` - Flag if server requires API key
- `--auth-type "type"` - Authentication type (oauth/api-key/custom)
- `--key-name "ENV_VAR"` - Environment variable name for API key
- `--auth-instructions "text"` - Instructions for authentication
- `--use-uvx` - Use uvx (Python package runner) instead of npx

## Automated Discovery System

MCPfinder includes automated scrapers that discover new MCP servers from various sources and register them daily.

### Available Scrapers

1. **MCP.so Feed** - Monitors https://mcp.so/feed for new server announcements
2. **GitHub Repositories** - Scans modelcontextprotocol/servers and wong2/awesome-mcp-servers
3. **MCPServers.org** - Parses mcpservers.org website for server listings
4. **Glama.ai** - Monitors glama.ai/mcp/servers for new additions

**Important**: The scrapers automatically skip GitHub repositories as they require manual installation. Only npm packages and SSE/HTTP servers are registered automatically.

### Running Scrapers

```bash
# Run all scrapers once
node index.js scrape

# Run scrapers once and exit (for cron jobs)
node index.js scrape --once

# Start daily scheduler (runs at 6 AM UTC)
node index.js schedule-scraper

# View scraper results log
node src/scrapers/view-log.js
```

### Environment Variables for Automation

- `GITHUB_TOKEN` - GitHub token for higher API rate limits
- `SCRAPER_SCHEDULE` - Cron schedule (default: "0 6 * * *")
- `WEBHOOK_URL` - Slack/Discord webhook for notifications
- `RUN_IMMEDIATELY=true` - Run immediately when scheduler starts

### Usage
```bash
npx -y @mcpfinder/server register
```

### Features

1. **Automatic Introspection**: Connects to the MCP server to discover capabilities
2. **Multi-Transport Support**: 
   - STDIO for npm packages via npx
   - STDIO for Python packages via uvx
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

1. **SSE Origin Validation**: Some SSE servers may fail with "Endpoint origin does not match connection origin" if they return mismatched protocols (http vs https). The tool will automatically retry using mcp-remote as a stdio transport.

2. **Token Format**: The tool expects Bearer tokens. Other authentication methods may require manual registration.

3. **HTTP/SSE Compatibility**: When HTTP or SSE transports fail, the tool automatically falls back to using `npx mcp-remote <url>` as a stdio transport. This ensures compatibility with servers that have transport-specific issues.

4. **OAuth Authentication**: Some servers like whenmeet.me require OAuth authentication that isn't fully compatible with the MCP SDK. For these servers:
   - Choose "n" when asked if you have a token
   - Choose "n" for manual capability entry  
   - The server will be registered with minimal information
   - The manifest will use `npx mcp-remote` for installation, which handles OAuth properly

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

### Input Requirements

#### Tags
- Must contain only lowercase letters, numbers, and hyphens
- Pattern: `^[a-z0-9-]+$`
- Examples: `ai`, `github`, `productivity`, `code-analysis`
- Invalid examples: `AI Tools`, `Code Analysis`, `testing apps, games`
- The tool will automatically clean invalid characters and warn about skipped tags

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