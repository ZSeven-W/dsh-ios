/**
 * Local lossless-JSON value type.
 *
 * DSH 0.1.5 no longer re-exports `JsonValue` from `@deepseek-ai/dsh-tools`
 * (it lives in `@deepseek-ai/dsh-util-values` there). The plugin keeps this
 * local structural alias — identical to the canonical definition — instead
 * of adding a host-utility dependency for one type. Presentation metadata
 * crossing the lossless-JSON boundary must satisfy exactly this shape.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
