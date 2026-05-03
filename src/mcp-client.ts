import { logger } from "./logger.js";

export interface ResearchResult {
  id: number;
  query: string;
  sources: unknown;
  analysis: unknown;
  report: string | null;
  created_at: string;
}

export interface SubabaseMcpClient {
  findResearchResult(query: string): Promise<ResearchResult | null>;

  insertResearchResult(params: {
    query: string;
    sources: unknown;
    analysis: unknown;
    report: string;
  }): Promise<ResearchResult>;

  queryResearchResults(params: {
    limit?: number;
    queryFilter?: string;
    orderBy?: "recent" | "oldest";
  }): Promise<ResearchResult[]>;
}

// ─── Implementation ───────────────────────────────────────────────────────────

class SupabaseMcpClientImpl implements SubabaseMcpClient {
  private readonly baseUrl: string;
  private requestId = 0;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async callJsonRpc(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const id = ++this.requestId;
    const request = {
      jsonrpc: "2.0",
      method,
      params,
      id,
    };

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const result = (await response.json()) as {
      jsonrpc: string;
      result?: unknown;
      error?: { code: number; message: string };
      id: number;
    };

    if (result.error) {
      throw new Error(`JSONRPC error: ${result.error.message}`);
    }

    return result.result;
  }

  async findResearchResult(query: string): Promise<ResearchResult | null> {
    return (await this.callJsonRpc("find_research_result", { query })) as ResearchResult | null;
  }

  async insertResearchResult(params: {
    query: string;
    sources: unknown;
    analysis: unknown;
    report: string;
  }): Promise<ResearchResult> {
    return (await this.callJsonRpc("insert_research_result", params)) as ResearchResult;
  }

  async queryResearchResults(params: {
    limit?: number;
    queryFilter?: string;
    orderBy?: "recent" | "oldest";
  }): Promise<ResearchResult[]> {
    return (await this.callJsonRpc("query_research_results", params)) as ResearchResult[];
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a client for the Supabase MCP server.
 *
 * The MCP server must be running separately (start it in another terminal).
 * This client simply connects to it via HTTP — no subprocess management.
 *
 * @param baseUrl The HTTP endpoint of the MCP server (default: http://localhost:3000)
 * @returns A SubabaseMcpClient ready to use
 * @throws If unable to connect to the server
 */
export async function createMcpClient(baseUrl = "http://localhost:3000"): Promise<SubabaseMcpClient> {
  // Verify the server is reachable
  logger.info({},`[mcp-client] Connecting to Supabase MCP server at ${baseUrl}`);

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "query_research_results",
      params: { limit: 1 },
      id: 1,
    }),
  }).catch((err) => {
    throw new Error(
      `Failed to connect to Supabase MCP server at ${baseUrl}. ` +
      `Make sure it's running: cd ../supabase-mcp-server && npm start. ` +
      `(Original error: ${err instanceof Error ? err.message : String(err)})`
    );
  });

  if (!response.ok) {
    throw new Error(`Server returned HTTP ${response.status}`);
  }

  logger.info({}, `[mcp-client] Connected successfully`);

  return new SupabaseMcpClientImpl(baseUrl);
}
