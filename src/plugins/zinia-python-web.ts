import { WebPlugin } from '@capacitor/core';
import type { ZiniaPythonPlugin } from './zinia-python';
import { DEV_BRIDGE } from './dev-bridge-flag';

const NO_RUNTIME =
  'The Python runtime is part of the iOS app. This web preview has no interpreter, so code cannot run here. ' +
  'Build the iOS app (see docs/BUILDING-IOS.md) or start the desktop development bridge with "npm run dev:bridge".';

/**
 * Browser implementation: every runtime call fails clearly. There is no
 * simulated interpreter anywhere in ZiniaPython.
 */
class UnavailablePython extends WebPlugin {
  private fail(): never {
    throw this.unavailable(NO_RUNTIME);
  }
  async ping(): Promise<never> { this.fail(); }
  async initialize(): Promise<never> { this.fail(); }
  async getRuntimeInfo(): Promise<never> { this.fail(); }
  async execute(): Promise<never> { this.fail(); }
  async executeFile(): Promise<never> { this.fail(); }
  async interrupt(): Promise<never> { this.fail(); }
  async provideInput(): Promise<never> { this.fail(); }
  async replExecute(): Promise<never> { this.fail(); }
  async resetInterpreter(): Promise<never> { this.fail(); }
  async runSelfTest(): Promise<never> { this.fail(); }
  async checkModules(): Promise<never> { this.fail(); }
  async listPackages(): Promise<never> { this.fail(); }
  async analyzePackage(): Promise<never> { this.fail(); }
  async installPackage(): Promise<never> { this.fail(); }
  async uninstallPackage(): Promise<never> { this.fail(); }
}

export async function createWebImplementation(): Promise<ZiniaPythonPlugin> {
  if (import.meta.env.DEV && DEV_BRIDGE) {
    const { DevBridgePython } = await import('./dev-bridge-python');
    return new DevBridgePython() as unknown as ZiniaPythonPlugin;
  }
  return new UnavailablePython() as unknown as ZiniaPythonPlugin;
}
