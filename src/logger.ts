import pino from "pino";
import fs from "node:fs";
import path from "node:path";

const OUTPUT_DIR = "./output";
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Each run gets its own log file so post-run inspection is unambiguous.
export const logPath = path.join(
  OUTPUT_DIR,
  `run-${new Date().toISOString().replace(/[:.]/g, "-")}.log`
);

const stdoutLevel = process.env.LOG_LEVEL ?? "info";

// Two transports:
//   stdout — pretty (TTY) or JSON (piped/CI); info+ by default, override with LOG_LEVEL
//   file   — always NDJSON at debug level, capturing full message history each iteration
export const logger = pino(
  { level: "debug" },
  pino.transport({
    targets: process.stdout.isTTY
      ? [
          { target: "pino-pretty", level: stdoutLevel, options: { colorize: true } },
          { target: "pino/file",   level: "debug",      options: { destination: logPath } },
        ]
      : [
          { target: "pino/file", level: stdoutLevel, options: { destination: 1 } },
          { target: "pino/file", level: "debug",     options: { destination: logPath } },
        ],
  })
);

export type Logger = pino.Logger;
