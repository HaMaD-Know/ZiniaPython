import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type {
  ExecuteFileOptions,
  ExecuteOptions,
  InstalledPackage,
  InterruptResult,
  ModuleCheck,
  OutputChunk,
  PackageAnalysis,
  PackageProgress,
  PythonExecutionResult,
  PythonRuntimeInfo,
  ReplOptions,
  SelfTestReport,
} from '../types/python';

/**
 * The native ZiniaPython plugin (ios/App/App/ZiniaPython/ZiniaPythonPlugin.swift).
 *
 * There is deliberately no JavaScript implementation of Python. In a plain web
 * browser every method rejects with code "UNAVAILABLE"; the optional desktop
 * development bridge (dev server only) forwards to real desktop CPython.
 */
export interface ZiniaPythonPlugin {
  ping(options?: { message?: string }): Promise<{ pong: boolean; pluginVersion: string; compiledPythonVersion: string; interpreterState: string }>;
  initialize(): Promise<PythonRuntimeInfo>;
  getRuntimeInfo(): Promise<Partial<PythonRuntimeInfo> & { busy?: boolean }>;
  execute(options: ExecuteOptions): Promise<PythonExecutionResult>;
  executeFile(options: ExecuteFileOptions): Promise<PythonExecutionResult>;
  interrupt(options: { executionId: string }): Promise<InterruptResult>;
  provideInput(options: { executionId: string; text?: string; eof?: boolean }): Promise<{ accepted: boolean }>;
  replExecute(options: ReplOptions): Promise<PythonExecutionResult>;
  resetInterpreter(): Promise<{ replReset: boolean; modulesForgotten: string[] }>;
  runSelfTest(options?: { modules?: boolean }): Promise<SelfTestReport>;
  checkModules(options: { names?: string[] }): Promise<{ modules: ModuleCheck[] }>;
  listPackages(): Promise<{ packages: InstalledPackage[]; siteDir: string | null; bundledDirs: string[] }>;
  analyzePackage(options: { name: string; version?: string }): Promise<PackageAnalysis>;
  installPackage(options: { name: string; version?: string }): Promise<{ installed: { name: string; version: string; requested: boolean }[] }>;
  uninstallPackage(options: { name: string }): Promise<{ name: string; version: string; removedFiles: number }>;

  addListener(eventName: 'output', listener: (event: { chunks: OutputChunk[] }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'inputRequest', listener: (event: { executionId: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'packageProgress', listener: (event: PackageProgress) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export const ZiniaPython = registerPlugin<ZiniaPythonPlugin>('ZiniaPython', {
  web: () => import('./zinia-python-web').then((m) => m.createWebImplementation()),
});
