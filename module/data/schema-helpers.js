/**
 * Small helpers for Foundry System DataModels.
 *
 * The current system still contains a lot of dynamic data that is prepared at
 * runtime by Actor/Item document classes. For the first v13/v14-compatible
 * DataModel pass Im intentionally keep several nested structures as ObjectField
 * instead of over-validating them. This preserves existing worlds and packs
 * while moving the system away from legacy system-template initialization.
 */

export function clone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function fields() {
  return foundry.data.fields;
}

export function stringField(initial = "") {
  return new (fields().StringField)({ required: true, nullable: false, initial });
}

export function htmlField(initial = "") {
  const { HTMLField } = fields();
  return new HTMLField({ required: true, nullable: false, initial });
}

export function numberField(initial = 0) {
  return new (fields().NumberField)({ required: true, nullable: false, initial });
}

export function booleanField(initial = false) {
  return new (fields().BooleanField)({ required: true, nullable: false, initial });
}

export function objectField(initial = {}) {
  return new (fields().ObjectField)({ required: true, nullable: false, initial: clone(initial) });
}

export function arrayField(elementField = null, initial = []) {
  const { ArrayField, AnyField } = fields();
  return new ArrayField(elementField ?? new AnyField(), { required: true, nullable: false, initial: clone(initial) });
}

export function filePathField(initial = "", categories = ["IMAGE"]) {
  const { FilePathField } = fields();
  return new FilePathField({ required: true, nullable: false, initial, categories, blank: true });
}

/**
 * Coerce a stored icon value into something the IMAGE `filePathField` above will accept.
 *
 * Legacy worlds can hold an icon that is a template-wrapper object, or a plain string with no
 * (or a non-image) file extension. Foundry v13+ validates FilePathField on load, so such a value
 * throws "icon: does not have a valid file extension" and makes the WHOLE actor fail to load.
 * We mirror the field's own check (CONST.FILE_CATEGORIES.IMAGE, so this can never drift from what
 * the field accepts) and fall back to "" (blank is allowed) when the value is unusable; the icon
 * can simply be re-selected afterwards.
 */
export function normalizeIconPath(value, fallback = "") {
  if (value && typeof value === "object") value = value.default ?? fallback;
  if (typeof value !== "string" || value === "") return fallback;
  const image = CONST.FILE_CATEGORIES.IMAGE;
  const { hasFileExtension, isBase64Data } = foundry.data.validators;
  const isImage = hasFileExtension(value, Object.keys(image)) || isBase64Data(value, Object.values(image));
  return isImage ? value : fallback;
}

export function mergeDefaults(source, defaults) {
  source ??= {};
  const mergeObject = globalThis.foundry?.utils?.mergeObject;
  if (mergeObject) {
    return mergeObject(clone(defaults), source, {
      inplace: false,
      insertKeys: true,
      insertValues: true,
      overwrite: true,
      recursive: true
    });
  }
  return { ...clone(defaults), ...source };
}

export function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function normalizeArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return clone(fallback);
  return [value];
}
