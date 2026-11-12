export * as ConfigWatch from "./watch.js"

import os from "os"
import path from "path"
import { FSUtil } from "@opencode/util/fs-util"
import type { Watcher } from "../filesystem/watcher.js"
import type { ConfigDiscovery } from "./discovery.js"

function isRootOrSystemParent(dir: string): boolean {
  if (dir === path.parse(dir).root) return true
  const homedir = os.homedir()
  const userRoot = path.dirname(homedir)
  if (dir === userRoot && dir !== homedir) return true
  if (process.platform === "darwin" && (dir === "/Library/Application Support" || dir === "/Library")) return true
  if (process.platform === "win32" && (dir.toLowerCase() === "c:\\programdata" || dir.toLowerCase() === "c:\\users")) return true
  return false
}

export function plan(sources: ConfigDiscovery.Sources) {
  const directories = [
    ...(sources.system?.present ? [sources.system.path] : []),
    ...(sources.global ? [sources.global] : []),
    ...sources.project.filter((root) => root.present).map((root) => root.path),
  ]
  const files = [
    ...(sources.system ? [sources.system.path] : []),
    ...sources.direct,
    ...sources.project.map((root) => root.path),
    ...sources.claude,
    ...sources.agents,
    ...(sources.explicit ? [sources.explicit] : []),
  ]
  // Keep a parent watch for each root so deletion/recreation is observable.
  const parents = Map.groupBy(
    files
      .filter((file) => !directories.some((directory) => file !== directory && FSUtil.contains(directory, file)))
      .filter((file) => !isRootOrSystemParent(path.dirname(file))),
    (file) => path.dirname(file),
  )
  return new Map(
    [
      ...directories.map((path) => ({
        path,
        type: "directory" as const,
        ignore: FSUtil.ignoreGlobs,
      })),
      ...Array.from(parents, ([parent, files]) => ({
        path: parent,
        type: "entries" as const,
        names: [...new Set(files.map((file) => path.basename(file)))].toSorted(),
      })),
    ].map((target) => [JSON.stringify(target), target satisfies Watcher.WatchInput]),
  )
}
