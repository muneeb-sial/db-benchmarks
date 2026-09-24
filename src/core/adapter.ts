/**
 * The contract every database implements, in its own `databases/<name>/adapter.ts`.
 *
 * `supportedRuntimes` marks where the driver is known to work, because
 * runtimes x databases is not a full grid. The benchmarks themselves live
 * behind `suite` (see src/suite/specs.ts).
 */

// Deliberately not a TS `enum`: enums are non-erasable and Node's type-stripping
// rejects them outright. This `as const` pattern is the erasable equivalent.
export const Runtime = {
  Node: 'node',
  Bun: 'bun',
} as const;
