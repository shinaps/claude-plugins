export {
  createApp,
  createTestApp,
  startServer,
  type CreateAppOptions,
  type StartServerOptions,
  type StartedServer,
  type CreateTestAppResult,
  type FileSource,
  type SourcesMap,
} from './server'
export { parseDiff, langForPath, type FileChange, type Hunk } from './diff-parser'

// v4.7.0 panel model 系
export {
  validateSummarySchema,
  detectLegacy,
  SchemaError,
  type ValidatedSummary,
  type LegacyDetection,
} from './summary-schema'
export {
  validateCoverage,
  formatMissesForStderr,
  type CoverageReport,
  type CoverageMiss,
} from './coverage-validator'
export {
  validateRangeSymmetry,
  formatRangeSymmetryViolations,
  buildLineMappings,
  type RangeSymmetryViolation,
  type RangeSymmetryReport,
} from './range-symmetry'
export {
  validatePanelExclusivity,
  formatExclusivityConflicts,
  type ExclusivityConflict,
  type ExclusivityReport,
} from './panel-exclusivity'
export {
  extractGroupPatch,
  type ExtractGroupPatchInput,
  type ExtractGroupPatchResult,
} from './extract-group-patch'
export { renderPanel, type RenderMode } from './panel-renderer'
