import assert from "node:assert/strict";
import test from "node:test";

const ROOT_EXPORTS = [
  "AUTO_COMPACT_STATES",
  "AUTO_COMPACT_TOOL_NAME",
  "AUTO_COMPACT_USAGE",
  "AUTO_COMPACT_WIDGET_KEY",
  "DEFAULT_AUTO_COMPACT_SETTINGS",
  "DEFAULT_PRE_COMPACT_PROMPT",
  "autoCompactCommandDescription",
  "buildPreCompactPrompt",
  "configuredAgentDir",
  "createAutoCompactController",
  "getAutoCompactArgumentCompletions",
  "isValidThreshold",
  "mergeAutoCompactSettings",
  "parseAutoCompactCommand",
  "readConfiguredAutoCompactSettings",
  "registerPiAutoCompact",
  "resolveAutoCompactSettings",
  "utilizationAtOrAboveThreshold",
  "writeConfiguredAutoCompactSettings",
];

test("package exports resolve through the declared public surface", async () => {
  const [root, command, controller, settings, extension] = await Promise.all([
    import("@hypercarrier/hc-auto-compact"),
    import("@hypercarrier/hc-auto-compact/command"),
    import("@hypercarrier/hc-auto-compact/controller"),
    import("@hypercarrier/hc-auto-compact/settings"),
    import("@hypercarrier/hc-auto-compact/extension"),
  ]);

  assert.deepEqual(Object.keys(root).sort(), ROOT_EXPORTS.toSorted());
  assert.equal(root.parseAutoCompactCommand, command.parseAutoCompactCommand);
  assert.equal(root.createAutoCompactController, controller.createAutoCompactController);
  assert.equal(root.resolveAutoCompactSettings, settings.resolveAutoCompactSettings);
  assert.equal(root.registerPiAutoCompact, extension.default);
});
