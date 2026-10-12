// Browser stand-in for `fs`; nothing in the web app reads files client-side.
export function readFileSync(): never { throw new Error("fs is not available in the browser"); }
export default { readFileSync };
