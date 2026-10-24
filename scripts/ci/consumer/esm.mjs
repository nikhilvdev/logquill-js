// An ESM consumer of the installed tarball.
import assert from "node:assert/strict";
import { Logger, CollectingTransport, parseRecord, SCHEMA_VERSION } from "logquill";
import { Logger as BrowserLogger } from "logquill/browser";

const sink = new CollectingTransport();
const record = new Logger("consumer", { transports: [sink] }).info("hello", { user_id: 1 });
assert.equal(record?.schema_version, SCHEMA_VERSION);
assert.equal(parseRecord(JSON.parse(JSON.stringify(record))).message, "hello");
assert.equal(typeof BrowserLogger, "function");
console.log("ESM consumer OK");
