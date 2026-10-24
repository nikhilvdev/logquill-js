// Type-checked with no Node typings at all: the browser entry must not leak `Buffer`, `NodeJS`, etc.
import { Logger, ConsoleTransport } from "logquill/browser";

export const logger = new Logger("web", { transports: [new ConsoleTransport()] });
