export { analyzeDuplicationComparison, type DuplicationProviderOptions } from "./provider.ts"
export { DEFAULT_DUPLICATION_SETTINGS, JSCPD_DETECTOR_IDS, JSCPD_TOOL } from "./contract.ts"
export type {
  ChangedLineRange,
  CloneLocation,
  ClonePair,
  DetectorReport,
  DuplicationComparisonResult,
  DuplicationCoverage,
  DuplicationFailure,
  DuplicationFailureCode,
  DuplicationFinding,
  DuplicationInstance,
  DuplicationSettings,
  JscpdComparisonInput,
  JscpdConfig,
  JscpdDetector,
  JscpdDetectors,
  JscpdFile,
  JscpdIgnoreFile,
  JscpdSideInventory,
  JscpdSideReport,
} from "./contract.ts"
