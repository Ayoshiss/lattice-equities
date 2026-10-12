// Same as anchor-browser.ts, for server code and server rendering. Points at
// Anchor's CommonJS build, which is what Node loads without bundling.
// @ts-ignore Anchor ships no types for its dist files
import * as anchor from "../../node_modules/@anchor-lang/core/dist/cjs/index.js";
// @ts-ignore
export * from "../../node_modules/@anchor-lang/core/dist/cjs/index.js";
export default anchor;
