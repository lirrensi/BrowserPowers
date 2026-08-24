import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** App version, sourced from package.json to avoid drift across surfaces. */
export const VERSION = (require("../../package.json") as { version: string }).version;
