import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AsyncLocalStorage } from "async_hooks";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import { ExecuteCodeTool } from "./tools/ExecuteCodeTool";
import { PluginBridge } from "./PluginBridge";
import { ConfigurationLoader } from "./ConfigurationLoader";
import { createLogger } from "./logger";
import { Tool } from "./Tool";
import { HighLevelOverviewTool } from "./tools/HighLevelOverviewTool";
import { PenpotApiInfoTool } from "./tools/PenpotApiInfoTool";
import { ExportShapeTool } from "./tools/ExportShapeTool";
import { ImportImageTool } from "./tools/ImportImageTool";
import { ReplServer } from "./ReplServer";
import { ApiDocs } from "./ApiDocs";

/**
 * Session context for request-scoped data.
 */
export interface SessionContext {
    userToken?: string;
}

export class PenpotMcpServer {
    private readonly logger = createLogger("PenpotMcpServer");
    private readonly server: McpServer;
    private readonly tools: Map<string, Tool<any>>;
    public readonly configLoader: ConfigurationLoader;
    private app: any;
    public readonly pluginBridge: PluginBridge;
    private readonly replServer: ReplServer;
    private apiDocs: ApiDocs;

    /**
     * Manages session-specific context, particularly user tokens for each request.
     */
    private readonly sessionContext = new AsyncLocalStorage<SessionContext>();

    private readonly transports = {
        streamable: {} as Record<string, StreamableHTTPServerTransport>,
        sse: {} as Record<string, { transport: SSEServerTransport; userToken?: string }>,
    };

    private readonly port: number;
    private readonly webSocketPort: number;
    private readonly replPort: number;
    private readonly listenAddress: string;
    /**
     * the address (domain name or IP address) via which clients can reach the MCP server
     */
    public readonly serverAddress: string;

    constructor(private isMultiUser: boolean = false) {
        // read port configuration from environment variables
        this.port = parseInt(process.env.PENPOT_MCP_SERVER_PORT ?? "4401", 10);
        this.webSocketPort = parseInt(process.env.PENPOT_MCP_WEBSOCKET_PORT ?? "4402", 10);
        this.replPort = parseInt(process.env.PENPOT_MCP_REPL_PORT ?? "4403", 10);
        this.listenAddress = process.env.PENPOT_MCP_SERVER_LISTEN_ADDRESS ?? "localhost";
        this.serverAddress = process.env.PENPOT_MCP_SERVER_ADDRESS ?? "localhost";

        this.configLoader = new ConfigurationLoader();
        this.apiDocs = new ApiDocs();

        this.server = new McpServer(
            {
                name: "penpot-mcp-server",
                version: "1.0.0",
            },
            {
                instructions: this.getInitialInstructions(),
            }
        );

        this.tools = new Map<string, Tool<any>>();
        this.pluginBridge = new PluginBridge(this, this.webSocketPort);
        this.replServer = new ReplServer(this.pluginBridge, this.replPort);

        this.registerTools();
    }

    /**
     * Indicates whether the server is running in multi-user mode,
     * where user tokens are required for authentication.
     */
    public isMultiUserMode(): boolean {
        return this.isMultiUser;
    }

    /**
     * Indicates whether the server is running in remote mode.
     *
     * In remote mode, the server is not assumed to be accessed only by a local user on the same machine,
     * with corresponding limitations being enforced.
     * Remote mode can be explicitly enabled by setting the environment variable PENPOT_MCP_REMOTE_MODE
     * to "true". Enabling multi-user mode forces remote mode, regardless of the value of the environment
     * variable.
     */
    public isRemoteMode(): boolean {
        const isRemoteModeRequested: boolean = process.env.PENPOT_MCP_REMOTE_MODE === "true";
        return this.isMultiUserMode() || isRemoteModeRequested;
    }

    /**
     * Indicates whether file system access is enabled for MCP tools.
     * Access is enabled only in local mode, where the file system is assumed
     * to belong to the user running the server locally.
     */
    public isFileSystemAccessEnabled(): boolean {
        return !this.isRemoteMode();
    }

    public getInitialInstructions(): string {
        let instructions = this.configLoader.getInitialInstructions();
        instructions = instructions.replace("$api_types", this.apiDocs.getTypeNames().join(", "));
        return instructions;
    }

    /**
     * Retrieves the current session context.
     *
     * @returns The session context for the current request, or undefined if not in a request context
     */
    public getSessionContext(): SessionContext | undefined {
        return this.sessionContext.getStore();
    }

    private registerTools(): void {
        // Create relevant tool instances (depending on file system access)
        const toolInstances: Tool<any>[] = [
            new ExecuteCodeTool(this),
            new HighLevelOverviewTool(this),
            new PenpotApiInfoTool(this, this.apiDocs),
            new ExportShapeTool(this), // tool adapts to file system access internally
        ];
        if (this.isFileSystemAccessEnabled()) {
            toolInstances.push(new ImportImageTool(this));
        }

        for (const tool of toolInstances) {
            const toolName = tool.getToolName();
            this.tools.set(toolName, tool);

            // Register each tool with McpServer
            this.logger.info(`Registering tool: ${toolName}`);
            this.server.registerTool(
                toolName,
                {
                    description: tool.getToolDescription(),
                    inputSchema: tool.getInputSchema(),
                },
                async (args) => {
                    return tool.execute(args);
                }
            );
        }
    }

    private setupHttpEndpoints(): void {
        /**
         * Modern Streamable HTTP connection endpoint
         */
        this.app.all("/mcp", async (req: any, res: any) => {
            const userToken = req.query.userToken as string | undefined;

            await this.sessionContext.run({ userToken }, async () => {
                const { randomUUID } = await import("node:crypto");

                const sessionId = req.headers["mcp-session-id"] as string | undefined;
                let transport: StreamableHTTPServerTransport;

                if (sessionId && this.transports.streamable[sessionId]) {
                    transport = this.transports.streamable[sessionId];
                } else {
                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => randomUUID(),
                        onsessioninitialized: (id: string) => {
                            this.transports.streamable[id] = transport;
                        },
                    });

                    transport.onclose = () => {
                        if (transport.sessionId) {
                            delete this.transports.streamable[transport.sessionId];
                        }
                    };

                    await this.server.connect(transport);
                }

                await transport.handleRequest(req, res, req.body);
            });
        });

        /**
         * Legacy SSE connection endpoint
         */
        this.app.get("/sse", async (req: any, res: any) => {
            const userToken = req.query.userToken as string | undefined;

            await this.sessionContext.run({ userToken }, async () => {
                const transport = new SSEServerTransport("/messages", res);
                this.transports.sse[transport.sessionId] = { transport, userToken };

                res.on("close", () => {
                    delete this.transports.sse[transport.sessionId];
                });

                await this.server.connect(transport);
            });
        });

        /**
         * SSE message POST endpoint (using previously established session)
         */
        this.app.post("/messages", async (req: any, res: any) => {
            const sessionId = req.query.sessionId as string;
            const session = this.transports.sse[sessionId];

            if (session) {
                await this.sessionContext.run({ userToken: session.userToken }, async () => {
                    await session.transport.handlePostMessage(req, res, req.body);
                });
            } else {
                res.status(400).send("No transport found for sessionId");
            }
        });
    }

    private setupApiKeyMiddleware(): void {
        const apiKey = process.env.PENPOT_MCP_API_KEY;
        if (!apiKey) {
            return;
        }

        const matchesApiKey = (req: any): boolean => {
            const headerKey = req.headers["x-api-key"];
            if (typeof headerKey === "string" && headerKey === apiKey) {
                return true;
            }
            const authHeader = req.headers["authorization"];
            if (typeof authHeader === "string" && authHeader === `Bearer ${apiKey}`) {
                return true;
            }
            return false;
        };

        this.app.use((req: any, res: any, next: any) => {
            const protectedPaths = ["/mcp", "/sse", "/messages"];
            if (!protectedPaths.some((prefix) => req.path.startsWith(prefix))) {
                return next();
            }
            if (!matchesApiKey(req)) {
                res.status(401).send("Invalid MCP API key");
                return;
            }
            next();
        });
    }

    private setupPluginEndpoints(express: any): void {
        const pluginDir = process.env.PENPOT_MCP_PLUGIN_DIR;
        if (!pluginDir) {
            this.logger.warn("PENPOT_MCP_PLUGIN_DIR not set; plugin hosting disabled");
            return;
        }

        const manifestPath = path.join(pluginDir, "manifest.json");
        if (!existsSync(manifestPath)) {
            this.logger.warn(`Plugin manifest not found at ${manifestPath}; plugin hosting disabled`);
            return;
        }

        const pluginToken = process.env.PENPOT_MCP_PLUGIN_TOKEN;
        const allowedOrigin = process.env.PENPOT_MCP_PLUGIN_ALLOWED_ORIGIN || "*";
        const baseManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>;

        const withToken = (value: string): string => {
            if (!pluginToken) {
                return value;
            }
            if (value.startsWith("http")) {
                const separator = value.includes("?") ? "&" : "?";
                return `${value}${separator}token=${encodeURIComponent(pluginToken)}`;
            }
            const normalized = value.startsWith("/") ? value.slice(1) : value;
            return `plugin/${encodeURIComponent(pluginToken)}/${normalized}`;
        };

        const setCors = (res: any): void => {
            res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
            res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        };

        const requireToken = (req: any, res: any, next: any): void => {
            if (!pluginToken) {
                return next();
            }
            const token = req.query.token || req.params.token;
            if (token !== pluginToken) {
                res.status(401).send("Invalid plugin token");
                return;
            }
            next();
        };

        this.app.options("/manifest.json", (req: any, res: any) => {
            setCors(res);
            res.status(204).send();
        });

        this.app.get("/manifest.json", requireToken, (req: any, res: any) => {
            const manifest = { ...baseManifest };
            if (manifest.code) {
                manifest.code = withToken(manifest.code);
            }
            setCors(res);
            res.json(manifest);
        });

        this.app.get("/manifest/:token", requireToken, (req: any, res: any) => {
            const manifest = { ...baseManifest };
            if (manifest.code) {
                manifest.code = withToken(manifest.code);
            }
            setCors(res);
            res.json(manifest);
        });

        this.app.use("/plugin/:token", requireToken, (req: any, res: any, next: any) => {
            setCors(res);
            next();
        });
        this.app.use("/plugin/:token", express.static(pluginDir));

        this.app.use(requireToken, (req: any, res: any, next: any) => {
            setCors(res);
            next();
        });

        this.app.use(express.static(pluginDir));
        this.logger.info(`Plugin hosting enabled from ${pluginDir}`);
    }

    async start(): Promise<void> {
        const { default: express } = await import("express");
        this.app = express();
        this.app.use(express.json());

        this.setupApiKeyMiddleware();
        this.setupHttpEndpoints();
        this.setupPluginEndpoints(express);

        return new Promise((resolve) => {
            this.app.listen(this.port, this.listenAddress, async () => {
                this.logger.info(`Multi-user mode: ${this.isMultiUserMode()}`);
                this.logger.info(`Remote mode: ${this.isRemoteMode()}`);
                this.logger.info(`Modern Streamable HTTP endpoint: http://${this.serverAddress}:${this.port}/mcp`);
                this.logger.info(`Legacy SSE endpoint: http://${this.serverAddress}:${this.port}/sse`);
                this.logger.info(`WebSocket server URL: ws://${this.serverAddress}:${this.webSocketPort}`);

                // start the REPL server
                await this.replServer.start();

                resolve();
            });
        });
    }

    /**
     * Stops the MCP server and associated services.
     *
     * Gracefully shuts down the REPL server and other components.
     */
    public async stop(): Promise<void> {
        this.logger.info("Stopping Penpot MCP Server...");
        await this.replServer.stop();
        this.logger.info("Penpot MCP Server stopped");
    }
}
