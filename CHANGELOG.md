# Changelog

## [0.3.0] - 2024-12-19

### 🚀 Major Features
- **OAuth Server Support**: Automatic mcp-remote fallback for OAuth servers like whenmeet.me
- **Smart Tag Validation**: Auto-clean invalid tags to match API requirements (`^[a-z0-9-]+$`)
- **Enhanced Authentication**: Multi-token environment variable support for better compatibility

### 🔧 Registration Improvements
- **mcp-remote Integration**: Seamless fallback when HTTP/SSE transport fails
- **Tag Auto-Cleaning**: Convert "AI Tools" → "ai-tools", prevent registration failures
- **Update Tag Cleaning**: Automatically fix existing server tags during updates
- **Better Error Handling**: Clearer error messages and debugging info

### 🐛 Bug Fixes
- Fixed `clientOptions` scope issue in mcp-remote fallback
- Resolved infinite readline loops in error scenarios
- Fixed tag validation causing registration failures
- Improved bearer token authentication flow

### 📖 Documentation
- Updated CLAUDE.md with OAuth authentication guidance
- Added tag format requirements and examples
- Documented mcp-remote fallback behavior
- Added troubleshooting section for auth-required servers

### 🔄 OAuth Flow
When HTTP/SSE fails → Automatic mcp-remote fallback → Success with cached OAuth

## [0.2.1] - 2024-12-19

### Added
- Enhanced MCP implementation with HTTP/SSE transport support
- Comprehensive documentation in CLAUDE.md
- Registration command for submitting MCP servers to registry

### Features
- Automatic transport detection (STDIO, SSE, HTTP)
- Authentication support for protected servers
- Tag validation and cleaning
- Server introspection and capability discovery

### Commands
- `register` - Register MCP servers with MCPfinder
- Standard MCP tools: search, details, config management