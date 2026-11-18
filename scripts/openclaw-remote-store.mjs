import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { validateRemoteSettings } from "./openclaw-remote-backend.mjs";

export function createOpenClawRemoteStore(directory) {
  const path = join(directory, "openclaw-remote.json");
  const ownedByUser = stat => process.getuid === undefined || stat.uid === process.getuid();

  async function checkDirectory() {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || !ownedByUser(stat) || (stat.mode & 0o077) !== 0) {
      throw new Error("OpenClaw credential directory is not private.");
    }
  }

  return {
    async load() {
      let file;
      try {
        await checkDirectory();
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await file.stat();
        if (!stat.isFile() || !ownedByUser(stat) || (stat.mode & 0o077) !== 0 || stat.size > 32768) {
          throw new Error("OpenClaw credential file is not private or has an invalid size.");
        }
        return validateRemoteSettings(JSON.parse(await file.readFile("utf8")));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      } finally {
        await file?.close();
      }
    },
    async save(settings) {
      const checked = validateRemoteSettings(settings);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await checkDirectory();
      const pending = join(directory, `.openclaw-remote-${randomUUID()}.tmp`);
      const file = await open(pending, "wx", 0o600);
      try {
        try {
          await file.writeFile(JSON.stringify(checked));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(pending, path);
      } finally {
        await rm(pending, { force: true });
      }
    },
    async remove() {
      try {
        await checkDirectory();
        for (const name of await readdir(directory)) {
          if (/^\.openclaw-remote-[0-9a-f-]{36}\.tmp$/.test(name)) {
            await rm(join(directory, name), { force: true });
          }
        }
        await rm(path, { force: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
  };
}
