// @arcium-hq/client does `import anchor from "@anchor-lang/core"`, but Anchor's
// browser build has no default export. Re-export it with one.
// @ts-ignore Anchor ships no types for its dist files
import * as anchor from "../../node_modules/@anchor-lang/core/dist/browser/index.js";
// @ts-ignore
export * from "../../node_modules/@anchor-lang/core/dist/browser/index.js";
export default anchor;
