import { createAutoCompactController } from "./controller.mjs";

export default function registerPiAutoCompact(pi, options = {}) {
  return createAutoCompactController(pi, options);
}
