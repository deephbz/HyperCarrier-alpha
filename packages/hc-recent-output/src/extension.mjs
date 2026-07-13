import { complete, getModel } from "@earendil-works/pi-ai/compat";

export * from "./index.mjs";

import registerRecentOutput from "./index.mjs";

export default function registerPiRecentOutput(pi, config = {}) {
  return registerRecentOutput(pi, {
    ...config,
    piAi: config.piAi ?? { complete, getModel },
  });
}
