import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Where uploaded bytes live.
 *
 * The rest of the application never touches the filesystem. It hands a stream
 * to `put` and gets back an opaque key; later it hands the key back to `read`
 * or `remove`. Swapping local disk for object storage means writing one more
 * implementation of this interface and changing which one is exported — no
 * issue, comment or attachment code changes.
 *
 * Nothing here interprets the uploader's filename. Keys are generated, so a
 * file called `../../../etc/passwd` or `C:\\Windows\\System32\\x` is stored
 * under a UUID like everything else and the traversal has nowhere to go.
 */

export interface StoredObject {
  key: string;
  byteSize: number;
  /** SHA-256 of the stored bytes, for integrity checks and de-duplication. */
  digest: string;
}

export interface StorageProvider {
  readonly name: string;
  /** Streams `body` into storage and returns the key it was stored under. */
  put(body: ReadableStream<Uint8Array>, hint: { extension: string }): Promise<StoredObject>;
  /** Opens the stored object for streaming back to a client. */
  read(key: string): Promise<ReadableStream<Uint8Array>>;
  /** Size in bytes, or null when the object is gone. */
  size(key: string): Promise<number | null>;
  remove(key: string): Promise<void>;
}

/* ---------------------------------------------------------------- local */

/**
 * Local disk, which is what Docker Compose runs.
 *
 * `PRIO_STORAGE_DIR` points at a mounted volume so uploads survive a container
 * rebuild. The default is a path inside the project, which is what a developer
 * running `next dev` gets.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = "local";
  private readonly root: string;

  constructor(root = process.env.PRIO_STORAGE_DIR ?? path.join(process.cwd(), ".storage")) {
    this.root = path.resolve(root);
  }

  /**
   * Keys are `yyyy/mm/<uuid><ext>` — sharded by month so no single directory
   * accumulates every upload the company ever made.
   *
   * The date is taken from the clock at write time only; nothing reads it back,
   * so a key never has to be parsed to be used.
   */
  private newKey(extension: string): string {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const safeExtension = /^\.[A-Za-z0-9]{1,8}$/.test(extension) ? extension : "";
    return `${year}/${month}/${randomUUID()}${safeExtension}`;
  }

  /**
   * Resolves a key to a path and refuses anything that escapes the root.
   *
   * Keys are generated here, so this should never trigger — which is exactly
   * why it is checked: the day a key comes from somewhere else, this is what
   * stops it.
   */
  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    const prefix = this.root + path.sep;
    if (full !== this.root && !full.startsWith(prefix)) {
      throw new Error("Refusing a storage key that escapes the storage root.");
    }
    return full;
  }

  async put(
    body: ReadableStream<Uint8Array>,
    hint: { extension: string },
  ): Promise<StoredObject> {
    const key = this.newKey(hint.extension);
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });

    const hash = createHash("sha256");
    let byteSize = 0;

    /* Streamed, never buffered: a 200 MB video must not become a 200 MB
       string in the server's heap on its way to disk. */
    const source = Readable.fromWeb(
      body as Parameters<typeof Readable.fromWeb>[0],
    );
    source.on("data", (chunk: Buffer) => {
      byteSize += chunk.length;
      hash.update(chunk);
    });

    try {
      await pipeline(source, createWriteStream(full));
    } catch (error) {
      // A half-written file is worse than none; take it back out.
      await rm(full, { force: true }).catch(() => {});
      throw error;
    }

    return { key, byteSize, digest: hash.digest("hex") };
  }

  async read(key: string): Promise<ReadableStream<Uint8Array>> {
    const stream = createReadStream(this.resolve(key));
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  }

  async size(key: string): Promise<number | null> {
    try {
      const info = await stat(this.resolve(key));
      return info.size;
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}

/* --------------------------------------------------------------- export */

let provider: StorageProvider | null = null;

/**
 * The provider the application uses. Chosen once and reused, so the storage
 * root is resolved a single time per process.
 */
export function storage(): StorageProvider {
  provider ??= new LocalStorageProvider();
  return provider;
}

/** Test seam: lets a test point storage at a temporary directory. */
export function setStorageProvider(next: StorageProvider | null): void {
  provider = next;
}
