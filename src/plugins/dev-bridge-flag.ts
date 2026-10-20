/**
 * True only in the Vite dev server started with `npm run dev:bridge`.
 * Vite replaces import.meta.env.DEV with `false` in production builds, so this
 * constant folds to `false` and every branch guarded by it - including the
 * dynamic imports of the development bridge - is removed from the app bundle.
 */
export const DEV_BRIDGE: boolean = import.meta.env.DEV && import.meta.env.VITE_ZINIA_DEV_BRIDGE === '1';
