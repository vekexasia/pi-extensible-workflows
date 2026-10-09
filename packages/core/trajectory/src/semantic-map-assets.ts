/** Generated offline by scripts/build-semantic-map.mjs; included in Trajectory lock identity. */
export const SEMANTIC_MAP_BUILD_STAMP = "37710140c36734e0";
export type SemanticMapAssetName = "index.html" | "semantic-map.html" | "semantic-map.js" | "semantic-map.css";
export type SemanticMapAssetDigest = Readonly<{ bytes: number; sha256: string }>;
/** Expected final bytes of the parent shell and the three browser assets for this build; a server constant, not a browser asset. */
export const SEMANTIC_MAP_ASSET_MANIFEST: Readonly<{ schema: 1; stamp: string; versionParameter: "v"; assets: Readonly<Record<SemanticMapAssetName, SemanticMapAssetDigest>> }> = Object.freeze({
  schema: 1,
  stamp: SEMANTIC_MAP_BUILD_STAMP,
  versionParameter: "v",
  assets: Object.freeze({
    "index.html": Object.freeze({ bytes: 185955, sha256: "b4f82cb5fcddff85414d39d43e486aa9aefdfea5da24e943c9d18afa63aaf953" }),
    "semantic-map.html": Object.freeze({ bytes: 772188, sha256: "22db7f5d23031dc85f3a295d7833a47f5239a7f6f8baa66717d51eddb29a68a2" }),
    "semantic-map.js": Object.freeze({ bytes: 38346, sha256: "d05d9f57a3ee26ec91edab65eadc3088365cab8cdd91d0b9a1e341e2228ac7e5" }),
    "semantic-map.css": Object.freeze({ bytes: 13136, sha256: "594a40b1033dca4ba0cafc609356c6cb214445b4a0892e0f2b5bc36ba8718959" })
  })
});
