# MCP Finder Server (`@mcpfinder/server`)

**Meet the simplest way to supercharge your coding and AI agents with MCP — an "API for AI." MCP Finder enables language models to search for and install new capabilities on demand through client applications that support the MCP protocol. No coding or manual setup required.**

***"App Store for Agents"***

Users can request tools the AI doesn't have yet, or the AI can autonomously expand its own capabilities by discovering relevant MCP servers. From code generators and data analyzers to specialized knowledge tools, MCP Finder acts like a map and toolbox for AI — transforming static models into evolving, capability-hunting agents that grow more powerful with every interaction.

This Node.js application implements an MCP (Model Context Protocol) server designed to run locally alongside MCP clients (like Cursor, Claude Desktop, Windsurf). It provides tools that allow AI within the client to interact with the MCP ecosystem.

Specifically, it enables the AI assistant to:

1.  **Discover** available MCP servers registered in the central [MCP Finder Registry](https://mcpfinder.dev) (via `search_mcp_servers`).
2.  **Retrieve details** about specific servers (via `get_mcp_server_details`).
3.  **Manage** the client application's local MCP server configuration file (add/update via `add_mcp_server_config`, remove via `remove_mcp_server_config`).

**Note for AI Agents:** This server is the primary interface for finding and enabling new tools and capabilities requested by the user if they aren't already available in current MCP toolset. Use `search_mcp_servers` first when asked by the user for a capability you don't possess.

## Quick Start

Run in your terminal the interactive setup tool to automatically update the MCP configuration file:
```bash
npx -y @mcpfinder/server --setup
```
This command guides you through selecting your client (Cursor, VS Code, Claude, etc.) and adds the necessary `mcpfinder` entry to the correct configuration file (e.g., `~/.cursor/mcp.json`).

## Manual Configuration

To manually configure an MCP client, you need to create or modify its JSON configuration file to include an entry for `mcpfinder`.

**Configuration File Structure:**

```json
{
  "mcpServers": { 
    "mcpfinder": {
      "command": "npx",
      "args": [
        "-y",
        "@mcpfinder/server"
      ]
    },
    // ... other server entries ...
  }
}
```

**Note:** For Visual Studio Code (`settings.json`), the top-level key for MCP configurations must be `servers` instead of `mcpServers`.

## Running from source

*   Clone this repository, e.g., `git clone https://github.com/mcpfinder/server`
*   Run `node index.js` for Stdio mode or `node index.js --http` for HTTP mode.

### Options

When running from source (`node index.js`), the following command-line options are available:

*   `--setup`: Run the interactive setup helper described above. This automatically configures a client application (e.g., Cursor, Claude Desktop) to use this server. Mutually exclusive with other options like `--http` or `--port`.
*   `--http`: Run the server in HTTP mode instead of the default Stdio mode. Useful for direct testing or specific integrations, but may not work with clients expecting Stdio.
*   `--port <number>`: Specify the port for HTTP mode (default: 6181, overrides `MCP_PORT` env var).
*   `--api-url <url>`: Specify the MCP Finder Registry API URL (default: https://mcpfinder.dev, overrides `MCPFINDER_API_URL` env var).
*   `--help`: Display the help message.

The server uses the following environment variables:

*   `MCPFINDER_API_URL`: The base URL for the MCP Finder Registry API. Defaults to `https://mcpfinder.dev`.
*   `MCP_PORT` (HTTP Mode Only): The port number for the server to listen on. Defaults to `6181`.

## Provided Tools

This MCP server exposes the following tools to the connected AI assistant:

### 1. `search_mcp_servers`

*   **Description:** Searches the MCP Finder Registry for available MCP servers. This is the primary tool for discovering and accessing new tools, methods, features, or capabilities.
*   **Input Schema:**
    *   `query` (string, optional): Keywords to search for in tool name or description.
    *   `tag` (string, optional): Specific tag to filter by.
*   **Output:** A list of matching server summaries (server_id, name, description, URL, tags). The typical next step is to use `get_mcp_server_details` for more info or directly `add_mcp_server_config` to install one.

### 2. `get_mcp_server_details`

*   **Description:** Retrieves detailed information about a specific MCP server from the registry, including its full manifest and basic installation suggestions (command, environment variables). Use this after finding a server_id via `search_mcp_servers` to get more information before potentially adding it.
*   **Input Schema:**
    *   `server_id` (string, **required**): The unique MCPFinder ID of the MCP server.
*   **Output:** The detailed server manifest and installation hints. The next step is to use `add_mcp_server_config` to install the server.

### 3. `add_mcp_server_config`

*   **Description:** Adds or updates the configuration for a specific MCP server in the *client application's* local configuration file (e.g., Cursor's `~/.cursor/mcp.json`). You must provide *either* `client_type` OR `config_file_path`.
*   **Input Schema:**
    *   `server_id` (string, **required**): A unique identifier for the server configuration entry (the MCPFinder ID obtained from `search_mcp_servers`).
    *   `client_type` (string, optional): The type of client application (known types determined dynamically, examples: `'cursor'`, `'claude'`, `'windsurf'`). Mutually exclusive with `config_file_path`. Use this for standard client installations.
    *   `config_file_path` (string, optional): An *absolute path* or a path starting with `~` (home directory) to the target JSON configuration file (e.g., `/path/to/custom/mcp.json` or `~/custom/mcp.json`). Mutually exclusive with `client_type`. Use this for non-standard locations or custom clients.
    *   `mcp_definition` (object, optional): Defines the server configuration. If omitted, or if certain fields are missing, defaults will be fetched from the MCP Finder Registry based on the `server_id`.
        *   `command` (array of strings, optional): The command and its arguments (e.g., `["npx", "-y", "my-mcp-package"]`). If omitted, or if only `env`/`workingDirectory` are provided below, the default command is fetched from the registry.
        *   `env` (object, optional): Environment variables (e.g., `{"API_KEY": "YOUR_KEY"}`). Merged with defaults if `command` is omitted.
        *   `workingDirectory` (string, optional): The working directory for the server process. Merged with defaults if `command` is omitted.
*   **Output:** A success or error message.
*   **Note:** The key used to store this server's configuration within the JSON file (under `mcpServers` or `servers`) is automatically generated based on the server's registered URL (obtained via the `server_id`). The provided `server_id` is used as a fallback if a suitable key cannot be derived from the URL. The tool automatically detects whether to use `mcpServers` or `servers` as the top-level key based on the existing file structure, defaulting to `mcpServers`.

### 4. `remove_mcp_server_config`

*   **Description:** Removes the configuration for a specific MCP server from the client application's local configuration file. You must provide *either* `client_type` OR `config_file_path`. The `server_id` provided must match the configuration key name used when the server was added (which is typically derived from the server's URL, see `add_mcp_server_config` note).
*   **Input Schema:**
    *   `server_id` (string, **required**): The unique identifier (configuration key name) of the server configuration entry to remove.
    *   `client_type` (string, optional): The type of client application (known types determined dynamically, examples: `'cursor'`, `'claude'`, `'windsurf'`). Mutually exclusive with `config_file_path`.
    *   `config_file_path` (string, optional): An *absolute path* or a path starting with `~` (home directory) to the target JSON configuration file. Mutually exclusive with `client_type`.
*   **Output:** A success or error message indicating whether the entry was found and removed.

## Security Considerations

The tools `add_mcp_server_config` and `remove_mcp_server_config` modify files on the user's local system. This server itself does not perform permission checks; it relies entirely on the calling client for security enforcement.

## Contributing

For contributions, please contact: mcpfinder(dot}dev[at}domainsbyproxy{dot]com

## License

This project is licensed under the GNU Affero General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

It means you're free to use (including commercially), modify, and share it. However, if you run a modified version, you're also required to publicly share your version.
