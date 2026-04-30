const TAVILY_BASE = "https://api.tavily.com";

interface TavilySearchResult {
  url: string;
  title: string;
  content: string;
  score: number;
  raw_content?: string | null;
}

interface TavilySearchResponse {
  query: string;
  results: TavilySearchResult[];
  response_time: number;
}

async function tavilySearch(
  query: string,
  maxResults: number
): Promise<TavilySearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY environment variable is not set");

  const response = await fetch(`${TAVILY_BASE}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: Math.min(maxResults, 5),
      search_depth: "basic",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tavily search failed (${response.status}): ${body}`);
  }

  return response.json() as Promise<TavilySearchResponse>;
}

export async function handleSearchWeb(input: {
  query: string;
  num_results?: number;
}): Promise<string> {
  console.log(`  [tool] search_web: "${input.query}"`);
  const data = await tavilySearch(input.query, input.num_results ?? 3);

  const slim = data.results.map((r) => ({
    url: r.url,
    title: r.title,
    snippet: r.content,
  }));
  return JSON.stringify(slim);
}
