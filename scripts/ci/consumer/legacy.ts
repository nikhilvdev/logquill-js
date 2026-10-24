// Legacy `moduleResolution: node` ignores `exports`; the subpaths must still resolve (via `typesVersions`).
import { Logger } from "logquill";
import { Logger as BrowserLogger } from "logquill/browser";

export const both = [new Logger("legacy"), new BrowserLogger("legacy")];
