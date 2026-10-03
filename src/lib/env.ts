/**
 * Boot-time environment validation. Called from `src/instrumentation.ts`
 * (Node runtime, real server start only — never during `next build`).
 * Phase "security/ops" fills this in; the stub keeps the import valid.
 */
export function assertProductionEnv(): void {}
