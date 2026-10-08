import { rmSync } from "node:fs";
import path from "node:path";
import { run } from "./sync-google-drive.mjs";

const outputDir = path.join(process.cwd(), ".generated", "knowledge-base");
const hasDriveCredentials = Boolean(
  process.env.GOOGLE_DRIVE_ACCESS_TOKEN ||
    (process.env.GOOGLE_DRIVE_CLIENT_ID && process.env.GOOGLE_DRIVE_CLIENT_SECRET && process.env.GOOGLE_DRIVE_REFRESH_TOKEN),
);

if (!hasDriveCredentials) {
  if (process.env.GOOGLE_DRIVE_REQUIRED === "1") {
    throw new Error("Google Drive is required for this build, but Drive credentials are not configured.");
  }
  console.log("Google Drive credentials are not configured; using the checked-in read-only corpus for this build.");
  process.exit(0);
}

try {
  await run(["--output", outputDir, "--activate"]);
  console.log(`Prepared the Google Drive corpus at ${outputDir}. The repository knowledge-base files were not modified.`);
} catch (error) {
  rmSync(outputDir, { recursive: true, force: true });
  throw error;
}
