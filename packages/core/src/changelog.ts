import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { atomicJson, json } from "./io.js";
import { object } from "./utils.js";

const PACKAGE_NAME = "pi-extensible-workflows";
const STATE_DIRECTORY = "pi-extensible-workflows";
const STATE_FILE = "changelog-state.json";
const MAX_NOTICE_CHARACTERS = 6_000;

type ChangelogEntry = { version: string; body: string };
type PackageMetadata = { directory: string; version: string };

type ChangelogContext = Pick<ExtensionContext, "hasUI" | "mode"> & { ui: Pick<ExtensionContext["ui"], "notify"> };

function packageMetadata(value: unknown, directory: string): PackageMetadata | undefined {
  if (!object(value) || value.name !== PACKAGE_NAME || typeof value.version !== "string" || !value.version.trim()) return undefined;
  return { directory, version: value.version.trim() };
}

async function packageMetadataAt(directory: string): Promise<PackageMetadata | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    return packageMetadata(value, directory);
  } catch {
    return undefined;
  }
}

async function installedPackageMetadata(): Promise<PackageMetadata | undefined> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  for (const directory of [join(moduleDirectory, ".."), join(moduleDirectory, "../..")]) {
    const metadata = await packageMetadataAt(directory);
    if (metadata) return metadata;
  }
  return undefined;
}

function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(?:\[([^\]\r\n]+)\]|([^\s\r\n]+))(?:\s+-.*)?\s*$/.exec(line);
    if (heading) {
      const version = heading[1]?.trim() ?? heading[2]?.trim();
      current = undefined;
      if (version && version.toLowerCase() !== "unreleased") {
        current = { version, body: "" };
        entries.push(current);
      }
      continue;
    }
    if (current) current.body = current.body ? `${current.body}\n${line}` : line;
  }
  return entries;
}

async function readChangelog(directory: string): Promise<ChangelogEntry[]> {
  try {
    return parseChangelog(await readFile(join(directory, "CHANGELOG.md"), "utf8"));
  } catch {
    return [];
  }
}

function releaseEntries(entries: readonly ChangelogEntry[], currentVersion: string, previousVersion: string | undefined): ChangelogEntry[] {
  const currentIndex = entries.findIndex((entry) => entry.version === currentVersion);
  const current = entries[currentIndex];
  if (current === undefined || current.body.trim() === "") return [];
  if (previousVersion === currentVersion) return [];
  const previousIndex = previousVersion === undefined ? -1 : entries.findIndex((entry) => entry.version === previousVersion);
  const selected = previousIndex > currentIndex ? entries.slice(currentIndex, previousIndex) : [current];
  return selected.filter((entry) => entry.body.trim() !== "");
}

function noticeText(version: string, entries: readonly ChangelogEntry[]): string {
  const notes = entries.map((entry) => `## ${entry.version}\n${entry.body.trim()}`).join("\n\n");
  const bounded = notes.length > MAX_NOTICE_CHARACTERS ? `${notes.slice(0, MAX_NOTICE_CHARACTERS).trimEnd()}\n...` : notes;
  return `pi-extensible-workflows updated to ${version}\n\n${bounded}`;
}


async function lastNotifiedVersion(path: string): Promise<string | undefined> {
  try {
    const value: unknown = await json(path);
    return object(value) && typeof value.lastNotifiedVersion === "string" && value.lastNotifiedVersion.trim() ? value.lastNotifiedVersion : undefined;
  } catch {
    return undefined;
  }
}

export async function showChangelogNotice(context: ChangelogContext, agentDir: string, packageDirectory?: string): Promise<void> {
  if (!context.hasUI || (context.mode !== "tui" && context.mode !== "rpc")) return;
  const { ui } = context;
  try {
    const metadata = packageDirectory === undefined ? await installedPackageMetadata() : await packageMetadataAt(packageDirectory);
    if (!metadata) return;
    const statePath = join(agentDir, STATE_DIRECTORY, STATE_FILE);
    const previousVersion = await lastNotifiedVersion(statePath);
    if (previousVersion === metadata.version) return;
    const entries = releaseEntries(await readChangelog(metadata.directory), metadata.version, previousVersion);
    if (!entries.length) return;
    ui.notify(noticeText(metadata.version, entries), "info");
    try {
      await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
      await atomicJson(statePath, { lastNotifiedVersion: metadata.version });
    } catch {
      // The notice is advisory; a failed state write may repeat it on the next start.
    }
  } catch {
    // Changelog data is optional and must never prevent Pi startup.
  }
}
