import * as fs from "fs";
import * as path from "path";

export function createFixtureCustomFetcherExecutable(tmpDir: string): string {
  const fetcherBaseName = `custom-fetcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const executablePath = path.join(
    tmpDir,
    process.platform === "win32" ? `${fetcherBaseName}.cmd` : `${fetcherBaseName}.sh`,
  );

  if (process.platform === "win32") {
    fs.writeFileSync(
      executablePath,
      [
        "@echo off",
        "mkdir outs 2>nul",
        "(echo # Custom Scheduled Item)> outs\\from-custom.md",
        "mkdir outs\\from-custom 2>nul",
        "(echo attachment)> outs\\from-custom\\note.txt",
      ].join("\r\n"),
      "utf-8",
    );
  } else {
    fs.writeFileSync(
      executablePath,
      [
        "#!/bin/sh",
        "cat <<'EOF' > outs/from-custom.md",
        "# Custom Scheduled Item",
        "EOF",
        "mkdir -p outs/from-custom",
        "cat <<'EOF' > outs/from-custom/note.txt",
        "attachment",
        "EOF",
      ].join("\n"),
      "utf-8",
    );
    fs.chmodSync(executablePath, 0o755);
  }

  return executablePath;
}

export function createMarkerCustomFetcherExecutable(tmpDir: string, runMarkerPath: string): string {
  const fetcherBaseName = `start-stop-fetcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const executablePath = path.join(
    tmpDir,
    process.platform === "win32" ? `${fetcherBaseName}.cmd` : `${fetcherBaseName}.sh`,
  );

  if (process.platform === "win32") {
    fs.writeFileSync(
      executablePath,
      [
        "@echo off",
        `echo run>> \"${runMarkerPath}\"`,
        "mkdir outs 2>nul",
        "(echo # Started)> outs\\started.md",
      ].join("\r\n"),
      "utf-8",
    );
  } else {
    fs.writeFileSync(
      executablePath,
      [
        "#!/bin/sh",
        `echo run >> \"${runMarkerPath}\"`,
        "cat <<'EOF' > outs/started.md",
        "# Started",
        "EOF",
      ].join("\n"),
      "utf-8",
    );
    fs.chmodSync(executablePath, 0o755);
  }

  return executablePath;
}

export async function waitForWorkerStartAndFetchOpportunity(
  reservoirDir: string,
  options: {
    tickIntervalMs?: number;
    startupPollMs?: number;
    startupPollLimit?: number;
  } = {},
): Promise<void> {
  const tickIntervalMs = options.tickIntervalMs ?? 20;
  const startupPollMs = options.startupPollMs ?? 10;
  const startupPollLimit = options.startupPollLimit ?? 200;
  const pidPath = path.join(reservoirDir, ".res-fetcher.pid");
  const statusPath = path.join(reservoirDir, ".res-fetcher-status.json");

  for (let i = 0; i < startupPollLimit; i += 1) {
    if (fs.existsSync(pidPath) && fs.existsSync(statusPath)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, startupPollMs));
    if (i === startupPollLimit - 1) {
      throw new Error("Timed out waiting for worker startup files");
    }
  }

  // Allow at least one scheduler tick after startup so a fetch can run.
  await new Promise((resolve) => setTimeout(resolve, tickIntervalMs * 2));
}

export function countRunsFromMarker(runMarkerPath: string): number {
  if (!fs.existsSync(runMarkerPath)) {
    return 0;
  }
  return fs
    .readFileSync(runMarkerPath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim() === "run").length;
}
