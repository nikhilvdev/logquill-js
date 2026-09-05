import { closeSync, existsSync, fstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Formatter } from "../core/formatter.js";
import { Transport } from "./transport.js";

/** Options for {@link FileTransport}. */
export interface FileTransportOptions {
  /** Turns a `LogRecord` into the string this transport writes. Defaults to `JSONFormatter`. */
  formatter?: Formatter;
  /** Rotate once the file reaches this many bytes. `0` disables rotation. Default 10MB. */
  maxBytes?: number;
  /** How many rotated backups (`.1`, `.2`, ...) to keep. The oldest is deleted once exceeded. Default 5. */
  backupCount?: number;
}

/** Appends formatted records to a file, rotating when it exceeds `maxBytes`. */
export class FileTransport extends Transport {
  /** Path of the file records are appended to. */
  readonly path: string;
  /** File is rotated once it reaches this many bytes. `0` disables rotation. */
  readonly maxBytes: number;
  /** How many rotated backups (`.1`, `.2`, ...) are kept. */
  readonly backupCount: number;
  private fd: number;

  constructor(path: string, options: FileTransportOptions = {}) {
    super(options.formatter);
    this.path = path;
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.backupCount = options.backupCount ?? 5;
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(this.path, "a");
  }

  /** Appends one formatted line to the file, rotating first if `maxBytes` has been exceeded. */
  write(formatted: string): void {
    writeSync(this.fd, formatted + "\n");
    if (this.maxBytes > 0 && fstatSync(this.fd).size >= this.maxBytes) {
      this.rotate();
    }
  }

  private rotate(): void {
    closeSync(this.fd);

    if (this.backupCount > 0) {
      for (let index = this.backupCount - 1; index > 0; index--) {
        const src = `${this.path}.${String(index)}`;
        const dst = `${this.path}.${String(index + 1)}`;
        if (existsSync(src)) {
          if (existsSync(dst)) {
            unlinkSync(dst);
          }
          renameSync(src, dst);
        }
      }
      const backup = `${this.path}.1`;
      if (existsSync(backup)) {
        unlinkSync(backup);
      }
      renameSync(this.path, backup);
    } else {
      unlinkSync(this.path);
    }

    this.fd = openSync(this.path, "a");
  }

  override close(): void {
    closeSync(this.fd);
  }
}
