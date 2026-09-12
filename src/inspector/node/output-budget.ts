import { InspectorInputError, LIMITS } from "./input";

/** Sum byte counts without allocating large test buffers or truncating artifacts. */
export function assertInspectorOutputBudget(
  artifactBytes: Readonly<Record<string, number>>,
  maximumBytes: number = LIMITS.outputBytes,
): number {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new InspectorInputError("output_byte_limit");
  let total = 0;
  for (const bytes of Object.values(artifactBytes)) {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > maximumBytes - total
    )
      throw new InspectorInputError("output_byte_limit");
    total += bytes;
  }
  return total;
}

/** UTF-8 strings and typed-array view lengths match the bytes actually written. */
export function checkInspectorOutputFiles(
  files: Readonly<Record<string, string | Uint8Array>>,
  maximumBytes: number = LIMITS.outputBytes,
): number {
  return assertInspectorOutputBudget(
    Object.fromEntries(
      Object.entries(files).map(([name, data]) => [
        name,
        typeof data === "string"
          ? Buffer.byteLength(data, "utf8")
          : data.byteLength,
      ]),
    ),
    maximumBytes,
  );
}
