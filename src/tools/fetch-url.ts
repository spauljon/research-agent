const TAVILY_BASE = "https://api.tavily.com";

interface TavilyExtractResult {
  url: string;
  raw_content: string;
}

interface TavilyExtractResponse {
  results: TavilyExtractResult[];
  failed_results: { url: string; error: string }[];
  response_time: number;
}

async function tavilyExtract(url: string): Promise<TavilyExtractResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY environment variable is not set");

  const response = await fetch(`${TAVILY_BASE}/extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      urls: [url],
      extract_depth: "basic",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tavily extract failed (${response.status}): ${body}`);
  }

  return response.json() as Promise<TavilyExtractResponse>;
}

export async function handleFetchUrl(input: { url: string }): Promise<string> {
  console.log(`  [tool] fetch_url: ${input.url}`);
  const data = await tavilyExtract(input.url);

  if (data.failed_results.length > 0) {
    const failure = data.failed_results[0];
    return JSON.stringify({
      url: input.url,
      error: failure?.error ?? "Unknown extraction error",
    });
  }

  const result = data.results[0];
  if (!result) {
    return JSON.stringify({ url: input.url, error: "No content extracted" });
  }

  // Trim long pages so we don't blow the context window
  const MAX_CHARS = 12000;
  const content =
    result.raw_content.length > MAX_CHARS
      ? result.raw_content.slice(0, MAX_CHARS) + "\n\n[...truncated]"
      : result.raw_content;

  return JSON.stringify({ url: result.url, content });
}
