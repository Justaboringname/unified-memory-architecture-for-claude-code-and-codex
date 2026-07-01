import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** sha256 of a string. */
export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

/** sha256 of a file streamed from disk (memory-safe for the 193MB export). */
export function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => res(h.digest("hex")))
      .on("error", rej);
  });
}
