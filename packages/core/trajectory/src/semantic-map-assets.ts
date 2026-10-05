/** Generated offline by scripts/build-semantic-map.mjs; included in Trajectory lock identity. */
export const SEMANTIC_MAP_BUILD_STAMP = "d5c85f5d21203513";
export type SemanticMapAssetName = "index.html" | "semantic-map.html" | "semantic-map.js" | "semantic-map.css";
export type SemanticMapAssetDigest = Readonly<{ bytes: number; sha256: string }>;
/** Expected final bytes of the parent shell and the three browser assets for this build; a server constant, not a browser asset. */
export const SEMANTIC_MAP_ASSET_MANIFEST: Readonly<{ schema: 1; stamp: string; versionParameter: "v"; assets: Readonly<Record<SemanticMapAssetName, SemanticMapAssetDigest>> }> = Object.freeze({
  schema: 1,
  stamp: SEMANTIC_MAP_BUILD_STAMP,
  versionParameter: "v",
  assets: Object.freeze({
    "index.html": Object.freeze({ bytes: 186145, sha256: "8a8cbe5ac77702c384f67ac0b45dd8adb611b68fa52f70e5a2a8e8d0a63ee8ff" }),
    "semantic-map.html": Object.freeze({ bytes: 772188, sha256: "1e0da6229fea979fe4c05a952c2af7204469579b91d9fd45fff93d6e31da8c62" }),
    "semantic-map.js": Object.freeze({ bytes: 38346, sha256: "821511fc735bc31e9f244dcae0f509ab0195ccacb5a6702e469eaa0c0fce3a03" }),
    "semantic-map.css": Object.freeze({ bytes: 13136, sha256: "33f0a049e17bf0393709e79e5b91a3ba1b453b4e6d7551a3374b46565c18b511" })
  })
});
