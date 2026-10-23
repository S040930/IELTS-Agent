import type { LearningStore } from "./db.js";

type MethodKeys<T> = { [Key in keyof T]: T[Key] extends (...args: never[]) => unknown ? Key : never }[keyof T];
type MaybeAsyncMethods<T> = {
  [Key in MethodKeys<T>]: T[Key] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Result | Promise<Awaited<Result>>
    : never;
};

/** The local SQLite and deployed Postgres stores share this service contract. */
export type LearningRepository = MaybeAsyncMethods<LearningStore>;
