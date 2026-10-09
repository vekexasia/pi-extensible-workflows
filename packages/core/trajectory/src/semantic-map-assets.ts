/** Generated offline by scripts/build-semantic-map.mjs; included in Trajectory lock identity. */
export const SEMANTIC_MAP_BUILD_STAMP = "d48e5e3be431480f";
export type SemanticMapAssetName = "index.html" | "semantic-map.html" | "semantic-map.js" | "semantic-map.css";
export type SemanticMapAssetDigest = Readonly<{ bytes: number; sha256: string }>;
/** Expected final bytes of the parent shell and the three browser assets for this build; a server constant, not a browser asset. */
export const SEMANTIC_MAP_ASSET_MANIFEST: Readonly<{ schema: 1; stamp: string; versionParameter: "v"; assets: Readonly<Record<SemanticMapAssetName, SemanticMapAssetDigest>> }> = Object.freeze({
  schema: 1,
  stamp: SEMANTIC_MAP_BUILD_STAMP,
  versionParameter: "v",
  assets: Object.freeze({
    "index.html": Object.freeze({ bytes: 185992, sha256: "c8ef928faf85b000838bcd76346403bdfc51f8d8b008ecdeec7c909addc0e11d" }),
    "semantic-map.html": Object.freeze({ bytes: 772188, sha256: "01f5039c6b2601357c1807a87096d26b675e97c2da313c9f41aef3f8eb664070" }),
    "semantic-map.js": Object.freeze({ bytes: 38346, sha256: "9e052ac39afea26381216393fe993ca6becc4fd2487562aa6b78f70107146192" }),
    "semantic-map.css": Object.freeze({ bytes: 13136, sha256: "fd1ad887d051de00ff58552ec0e16277778e1c30853cfb0982b25bee57f3cdb8" })
  })
});
