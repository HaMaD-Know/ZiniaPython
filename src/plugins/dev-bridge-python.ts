import { WebPlugin } from '@capacitor/core';
import { devEvents, devPost } from './dev-bridge-client';

/**
 * Development only: forwards every ZiniaPython call to
 * `scripts/dev-bridge-worker.py` through the Vite dev server, i.e. to real
 * CPython on the developer's computer. It exists to work on the UI without an
 * iPhone; it is never part of a production build or the iOS app.
 */
export class DevBridgePython extends WebPlugin {
  constructor() {
    super();
    devEvents((name, data) => this.notifyListeners(name, data));
  }
  private call<T>(method: string, options: unknown = {}): Promise<T> {
    return devPost<T>(`python/${method}`, options);
  }
  ping() { return this.call('ping'); }
  initialize() { return this.call('initialize'); }
  getRuntimeInfo() { return this.call('getRuntimeInfo'); }
  execute(o: unknown) { return this.call('execute', o); }
  executeFile(o: unknown) { return this.call('executeFile', o); }
  interrupt(o: unknown) { return this.call('interrupt', o); }
  provideInput(o: unknown) { return this.call('provideInput', o); }
  postGraphicsEvents(o: unknown) { return this.call('postGraphicsEvents', o); }
  replExecute(o: unknown) { return this.call('replExecute', o); }
  resetInterpreter() { return this.call('resetInterpreter'); }
  runSelfTest(o: unknown) { return this.call('runSelfTest', o); }
  checkModules(o: unknown) { return this.call('checkModules', o); }
  listPackages() { return this.call('listPackages'); }
  analyzePackage(o: unknown) { return this.call('analyzePackage', o); }
  installPackage(o: unknown) { return this.call('installPackage', o); }
  uninstallPackage(o: unknown) { return this.call('uninstallPackage', o); }
}
