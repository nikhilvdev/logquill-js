import { closeSync, existsSync, fstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Formatter } from "../core/formatter.js";
import { Transport } from "./transport.js";

export interface FileTransportOptions {
  formatter?: Formatter;
  maxBytes?: number;
  backupCount?: number;
}

/** Appends formatted records to a file, rotating when it exceeds `maxBytes`. */
export class FileTransport extends Transport {
  readonly path: string;
  readonly maxBytes: number;
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
