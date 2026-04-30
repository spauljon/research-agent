export async function handleWriteReport(input: {
  filename: string;
  content: string;
}): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const outputPath = path.join(process.cwd(), "output", input.filename);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, input.content, "utf-8");
  console.log(`  [tool] write_report → ${outputPath}`);
  return JSON.stringify({ success: true, path: outputPath });
}
