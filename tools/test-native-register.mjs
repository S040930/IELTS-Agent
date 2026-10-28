// Optional offline runner for Node 24+. The normal npm test script still uses tsx.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        try { return nextResolve(specifier.slice(0, -3) + ".ts", context); } catch {}
      }
      throw error;
    }
  },
});
