import eslint from "@eslint/js";
import sonarjs from "eslint-plugin-sonarjs";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "crap-report/**", "node_modules/**"] },
  eslint.configs.recommended,
  sonarjs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      complexity: ["error", 30],
      "sonarjs/cognitive-complexity": ["error", 30],
      "sonarjs/no-duplicate-string": "off",
      "sonarjs/no-nested-conditional": "off",
      "sonarjs/no-nested-template-literals": "off",
      "sonarjs/regex-complexity": "off",
      "sonarjs/super-linear-regex": "off",
      "sonarjs/todo-tag": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["**/*.test.{js,mjs,ts,tsx}", "test/**", "scripts/**"],
    rules: {
      "sonarjs/no-hardcoded-passwords": "off",
      "sonarjs/no-duplicate-string": "off",
      "sonarjs/no-os-command-from-path": "off",
      "sonarjs/publicly-writable-directories": "off",
    },
  },
);
