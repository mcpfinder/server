# MCPfinder 🔧🤖 (`@mcpfinder/server`)

**Meet the simplest way to supercharge your coding and AI agents with MCP — an "API for AI." MCPfinder enables language models to search for and install new capabilities on demand through client applications that support the MCP protocol. No coding or manual setup required.**

***App Store for Agents***

Users can request tools the AI doesn't have yet, or the AI can autonomously expand its own capabilities by discovering relevant MCP servers. From code generators and data analyzers to specialized knowledge tools, MCPfinder acts like a map and toolbox for AI — transforming static models into evolving, capability-hunting agents that grow more powerful with every interaction.

***Plug-and-Play Tools for LLMs***

![Example](https://raw.githubusercontent.com/mcpfinder/server/main/example_chat.png)

This Node.js application implements an MCP (Model Context Protocol) server designed to run locally alongside MCP clients (like Cursor, Claude Desktop, Windsurf). It provides tools that allow AI within the client to interact with the MCP ecosystem.

Specifically, it enables the AI assistant to:

1.  **Discover** available MCP servers registered in the central [MCPfinder Registry](https://mcpfinder.dev) (via `search_mcp_servers`).
2.  **Retrieve details** about specific servers (via `get_mcp_server_details`).
3.  **Manage** the client application's local MCP server configuration file (add/update via `add_mcp_server_config`, remove via `remove_mcp_server_config`).

**Note for AI Agents:** This server is the primary interface for finding and enabling new tools and capabilities requested by the user if they aren't already available in current MCP toolset. Use `search_mcp_servers` first when asked by the user for a capability you don't possess.

## Quick Start

Run in your terminal the interactive setup tool to automatically update the MCP configuration file:
```bash
npx -y @mcpfinder/server install
```
This command guides you through selecting your client (Cursor, VS Code, Claude, etc.) and adds the necessary `mcpfinder` entry to the correct configuration file (e.g., `~/.cursor/mcp.json`).
See "Running from source" and "Commands and Options" for more details if you are working directly with the source code.

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
  }
}
```

**Note:** For Visual Studio Code (`settings.json`), the top-level key for MCP configurations must be `servers` instead of `mcpServers`.

## Running from source

*   Clone this repository, e.g., `git clone https://github.com/mcpfinder/server`
*   Run `node index.js` for Stdio mode or `node index.js --http` for HTTP mode.

### Commands and Options

When running from source (`node index.js`), the script can be invoked in several ways:

**Running the Server (Default Behavior):**
If no command is specified, `index.js` starts the MCP server.
*   **Stdio Mode (default):**
    ```bash
    node index.js
    ```
*   **HTTP Mode:**
    ```bash
    node index.js --http
    ```
    *   `--port <number>`: Specify the port for HTTP mode (default: 6181, or `MCP_PORT` env var).
    *   `--api-url <url>`: Specify the MCPfinder Registry API URL used by the tools (default: `https://mcpfinder.dev`, or `MCPFINDER_API_URL` env var).

**Executing Commands:**
*   `install`: Run the interactive setup to configure a client application.
    ```bash
    node index.js install
    ```
*   `register`: For server publishers to register their MCP server package with the MCPFinder registry.
    ```bash
    node index.js register
    ```

**Getting Help:**
*   `--help`: Display the help message detailing commands and options.
    ```bash
    node index.js --help
    ```

The server uses the following environment variables:

*   `MCPFINDER_API_URL`: The base URL for the MCPfinder Registry API. Defaults to `https://mcpfinder.dev`.
*   `MCP_PORT` (HTTP Mode Only): The port number for the server to listen on. Defaults to `6181`.

## Provided Tools

This MCP server exposes the following tools to the connected AI assistant:

### 1. `search_mcp_servers`

*   **Description:** Searches the MCPfinder Registry for available MCP servers. This is the primary tool for discovering and accessing new tools, methods, features, or capabilities.
*   **Input Schema:**
    *   `query` (string, optional): Keywords to search for in tool name or description.
    *   `tag` (string, optional): Specific tag to filter by.
*   **Output:** A list of matching server summaries (server_id, name, description, URL, tags). The typical next step is to use `get_mcp_server_details` for more info or directly `add_mcp_server_config` to install one.

⚠️ **Note:** The registry currently contains several hundred servers that can be run locally using `npx` in **stdio** mode without requiring environment variables for basic operation. Future updates will expand support to include a wider range of servers, including paid and commercial options that require environment keys.


### 2. `get_mcp_server_details`

*   **Description:** Retrieves detailed information about a specific MCP server from the registry, including its full manifest and basic installation suggestions (command, environment variables). Use this after finding a server_id via `search_mcp_servers` to get more information before potentially adding it.
*   **Input Schema:**
    *   `id` (string, **required**): The unique MCPfinder's server_id obtained from `search_mcp_servers`.
*   **Output:** The detailed server manifest and installation hints. The next step is to use `add_mcp_server_config` to install the server.

### 3. `add_mcp_server_config`

*   **Description:** Adds or updates the configuration for a specific MCP server in the *client application's* local configuration file (e.g., Cursor's `~/.cursor/mcp.json`). You must provide *either* `client_type` OR `config_file_path`.
*   **Input Schema:**
    *   `server_id` (string, **required**): A unique identifier for the server configuration entry (the MCPfinder ID obtained from `search_mcp_servers`).
    *   `client_type` (string, optional): The type of client application (known types determined dynamically, examples: `'cursor'`, `'claude'`, `'windsurf'`). Mutually exclusive with `config_file_path`. Use this for standard client installations.
    *   `config_file_path` (string, optional): An *absolute path* or a path starting with `~` (home directory) to the target JSON configuration file (e.g., `/path/to/custom/mcp.json` or `~/custom/mcp.json`). Mutually exclusive with `client_type`. Use this for non-standard locations or custom clients.
    *   `mcp_definition` (object, optional): Defines the server configuration. If omitted, or if certain fields are missing, defaults will be fetched from the MCPfinder Registry based on the `server_id`.
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

---

[![Badge](https://glama.ai/mcp/servers/@mcpfinder/server/badge)](https://glama.ai/mcp/servers/@mcpfinder/server)