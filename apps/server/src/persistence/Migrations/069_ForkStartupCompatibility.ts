import * as Effect from "effect/Effect";

import dropUnusedV1Projections from "./063_DropUnusedV1Projections.ts";
import startupQueryIndexes from "./063_StartupQueryIndexes.ts";

// Earlier fork builds recorded StartupQueryIndexes as migration 63. Preserve
// that history and run upstream's skipped 63 plus our indexes idempotently.
export default Effect.gen(function* () {
  yield* dropUnusedV1Projections;
  yield* startupQueryIndexes;
});
