// Lets node:test import the pbe-predictions Worker entry: wrangler bundles .ttf/.wasm/.jpg as Data/CompiledWasm modules;
// under Node they become empty stand-ins (route/entitlement tests never render PNGs).
import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, next) {
    if (/\.(ttf|wasm|jpg|png)$/.test(new URL(url).pathname)) return { format: 'module', source: 'export default new ArrayBuffer(0);', shortCircuit: true };
    return next(url, context);
  },
});
