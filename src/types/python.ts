/**
 * Types shared between the web UI and the native ZiniaPython plugin.
 * They mirror the JSON produced by python/zinia/bridge.py and
 * ios/App/App/ZiniaPython/ZiniaPythonPlugin.swift.
 */

export type RuntimeLifecycle =
  | 'not-initialized'
  | 'initializing'
  | 'ready'
  | 'running'
  | 'interrupt-requested'
  | 'completed'
  | 'failed'
  | 'unavailable';

export interface PythonRuntimeInfo {
  pythonVersion: string;
  pythonVersionFull: string;
  compiledPythonVersion?: string;
  implementation: string;
  platform: string;
  machine: string;
  ios?: { system: string; release: string; model: string; isSimulator: boolean } | null;
  prefix: string;
  stdlib: string;
  sysPath: string[];
  sitePackages: string | null;
  bundledPackages: string[];
  workspaceRoot: string | null;
  utf8Mode: boolean;
  nativeHost: boolean;
  interpreterState?: string;
  systemName?: string;
  systemVersion?: string;
  deviceModel?: string;
  availableMemoryBytes?: number;
  physicalMemoryBytes?: number;
  pluginVersion?: string;
  startupMs?: number;
  interruptSupport?: string;
  ziniaRuntimeVersion?: string;
  executionModel?: Record<string, unknown>;
  /** Set when the desktop development bridge is used instead of the iOS runtime. */
  devBridge?: boolean;
}

export interface TracebackFrame {
  filename: string;
  lineno: number | null;
  endLineno?: number | null;
  colno?: number | null;
  name: string;
  line: string;
  isLibrary: boolean;
}

export type ErrorCategory =
  | 'syntax'
  | 'import'
  | 'runtime'
  | 'interrupt'
  | 'exit'
  | 'memory'
  | 'environment';

export interface ModuleHelp {
  category: string;
  explanation: string;
  module?: string;
}

export interface PythonErrorInfo {
  type: string;
  message: string;
  category: ErrorCategory;
  traceback: string;
  frames: TracebackFrame[];
  location?: { filename: string; lineno: number | null; colno?: number | null };
  syntax?: {
    filename: string | null;
    lineno: number | null;
    offset: number | null;
    endLineno?: number | null;
    endOffset?: number | null;
    text: string;
  };
  missingModule?: string;
  moduleHelp?: ModuleHelp;
  exitCode?: number;
}

export type ExecutionStatus = 'ok' | 'error' | 'interrupted' | 'exit' | 'incomplete';

export interface PythonExecutionResult {
  executionId: string;
  status: ExecutionStatus;
  exitCode: number | null;
  durationMs: number;
  wallTimeMs?: number;
  error: PythonErrorInfo | null;
  outputChars: number;
  truncated: boolean;
  stoppedBy?: 'memory-guard';
  stdout?: string;
  stderr?: string;
}

export type OutputStreamName = 'stdout' | 'stderr' | 'system';

export interface OutputChunk {
  executionId: string;
  stream: OutputStreamName;
  text: string;
}

export interface ExecuteOptions {
  executionId: string;
  code: string;
  filename?: string;
  workingDirectory?: string;
  projectRoot?: string;
  stdin?: string;
  args?: string[];
}

export interface ExecuteFileOptions {
  executionId: string;
  path: string;
  workingDirectory?: string;
  projectRoot?: string;
  stdin?: string;
  args?: string[];
}

export interface ReplOptions {
  executionId: string;
  source: string;
  mode: 'line' | 'block';
  workingDirectory?: string;
  projectRoot?: string;
}

export interface InterruptResult {
  interrupted: boolean;
  mechanism: string;
  reason?: string;
}

export interface ModuleCheck {
  module: string;
  required: boolean;
  available: boolean;
  error?: string;
  file?: string;
  note?: string;
  help?: ModuleHelp;
  ms: number;
}

export interface SelfTestCase {
  id: string;
  title: string;
  passed: boolean;
  skipped?: boolean;
  status?: string | string[];
  [key: string]: unknown;
}

export interface SelfTestReport {
  python: string;
  implementation: string;
  platform: string;
  machine: string;
  cases: SelfTestCase[];
  modules: ModuleCheck[];
  summary: {
    casesPassed: number;
    casesFailed: number;
    failedCases: string[];
    modulesAvailable: number;
    modulesChecked: number;
    requiredModulesMissing: string[];
    ok: boolean;
    seconds: number;
  };
}

export type PackageVerdict =
  | 'installable'
  | 'native-ios-wheel'
  | 'native-only'
  | 'sdist-only'
  | 'python-mismatch'
  | 'no-files'
  | 'not-found';

export interface PackageFile {
  filename: string;
  kind: string;
  size?: number;
  platforms?: string[];
  yanked: boolean;
}

export interface PackageAnalysis {
  name: string;
  version: string;
  summary: string;
  homePage: string;
  license: string;
  requiresPython: string;
  pythonCompatible: boolean;
  dependencies: { requirement: string; name?: string; applies: boolean }[];
  installedVersion: string | null;
  verdict: PackageVerdict;
  reason: string;
  files: PackageFile[];
  platformFamilies: string[];
  selectedWheel: string | null;
}

export interface InstalledPackage {
  name: string;
  version: string;
  summary: string;
  source: 'user' | 'bundled';
  installer: string;
  requested: boolean;
  requires: string[];
}

export interface PackageProgress {
  operation: 'install' | 'uninstall';
  package: string;
  stage: string;
  message: string;
  time: number;
}

export interface PluginErrorShape {
  message: string;
  code?: string;
  data?: Record<string, unknown>;
}
