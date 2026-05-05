import type { ToolDefinition } from "../model-adapters/types.js";
import { handleSearchWeb } from "./search-web.js";
import { handleFetchUrl } from "./fetch-url.js";
import { handleWriteReport } from "./write-report.js";

export const TOOLS: ToolDefinition[] = [
  {
    name: "search_web",
    description:
      "Search the web for sources relevant to a query. Returns a list of URLs, titles, and short snippets. " +
      "Use this first to discover candidate sources, then call fetch_url for the ones you want full content from.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The search query" },
        num_results: { type: "number", description: "How many results to return (max 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch the full text content of a single URL. Use this after search_web to get the complete article body for sources you want to analyse in depth.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "write_report",
    description:
      "Save the final research report to disk as a markdown file. Call this once analysis is complete.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Output filename (e.g. report.md)" },
        content: { type: "string", description: "Full markdown content of the report" },
      },
      required: ["filename", "content"],
    },
  },
];

export async function dispatchTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "search_web":
      return handleSearchWeb(input as { query: string; num_results?: number });
    case "fetch_url":
      return handleFetchUrl(input as { url: string });
    case "write_report":
      return handleWriteReport(input as { filename: string; content: string });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
