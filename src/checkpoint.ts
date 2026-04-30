import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "./logger.js";
import type { Checkpoint } from "./types.js";

const OUTPUT_DIR = "./output";

export function checkpointPath(originalQuery: string): string {
  const hash = createHash("sha256").update(originalQuery).digest("hex").slice(0, 8);
  return join(OUTPUT_DIR, `checkpoint-${hash}.json`);
}

export async function loadCheckpoint(originalQuery: string): Promise<Checkpoint | null> {
  const path = checkpointPath(originalQuery);
  try {
    const raw = await readFile(path, "utf-8");
    const cp = JSON.parse(raw) as Checkpoint;
    if (cp.version !== 1 || cp.originalQuery !== originalQuery) {
      logger.warn({ path }, "checkpoint version or query mismatch — ignoring");
      return null;
    }
    logger.info({ path, completedStages: cp.completedStages }, "checkpoint found");
    return cp;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    logger.warn({ path, err }, "corrupt checkpoint file — ignoring");
    return null;
  }
}

export async function saveCheckpoint(
  originalQuery: string,
  stage: number,
  fields: Partial<Omit<Checkpoint, "version" | "originalQuery" | "createdAt" | "updatedAt" | "completedStages">>
): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const path = checkpointPath(originalQuery);

  // Read existing checkpoint or build a fresh skeleton.
  let existing: Checkpoint;
  try {
    const raw = await readFile(path, "utf-8");
    existing = JSON.parse(raw) as Checkpoint;
  } catch {
    existing = {
      version: 1,
      originalQuery,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedStages: [],
      reformulatedQuery: null,
      sources: null,
      analysis: null,
    };
  }

  const completedStages = existing.completedStages.includes(stage)
    ? existing.completedStages
    : [...existing.completedStages, stage];

  const updated: Checkpoint = {
    ...existing,
    ...fields,
    completedStages,
    updatedAt: new Date().toISOString(),
  };

  // Atomic write: tmp file then rename, so a crash mid-write never corrupts the checkpoint.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(updated, null, 2), "utf-8");
  await rename(tmp, path);
  logger.debug({ path, completedStages: updated.completedStages }, "checkpoint saved");
}

export async function clearCheckpoint(originalQuery: string): Promise<void> {
  const path = checkpointPath(originalQuery);
  try {
    await unlink(path);
    logger.debug({ path }, "checkpoint cleared");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
