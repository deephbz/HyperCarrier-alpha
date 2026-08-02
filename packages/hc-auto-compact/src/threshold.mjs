export function isValidThreshold(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 1 &&
    value < 110
  );
}
