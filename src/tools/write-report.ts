import { logger } from "../logger.js";

export async function handleWriteReport(input: {
  filename: string;
  content: string;
}): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const outputPath = path.join(process.cwd(), "output", input.filename);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, input.content, "utf-8");
  logger.info({ path: outputPath }, "tool: write_report");
  return JSON.stringify({ success: true, path: outputPath });
}
