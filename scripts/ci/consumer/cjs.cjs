// A CommonJS consumer of the installed tarball.
const assert = require("node:assert/strict");
const { Logger, CollectingTransport, parseRecord, SCHEMA_VERSION } = require("logquill");

const sink = new CollectingTransport();
const record = new Logger("consumer", { transports: [sink] }).info("hello", { user_id: 1 });
assert.equal(record?.schema_version, SCHEMA_VERSION);
assert.equal(parseRecord(JSON.parse(JSON.stringify(record))).message, "hello");

// The browser entry is ESM-only on purpose: there is no `require` condition for it.
assert.throws(() => require("logquill/browser"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
console.log("CJS consumer OK");
