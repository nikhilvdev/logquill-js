// Type-checked as an ES module under `module: nodenext`.
import { Logger, JSONFormatter, parseRecord, type LogRecord } from "logquill";

const record: LogRecord | null = new Logger("consumer").info("hello");
const line: string = new JSONFormatter().format(parseRecord(record));
export default line;
