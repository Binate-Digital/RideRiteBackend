import { EventEmitter } from "node:events";

/**
 * In-process bus for the admin dashboard's live counters (TRD 6.2). Trip / rental / chauffeur
 * models announce every write here (see watchForAdmins); realtime/index.js turns that into
 * throttled `admin:counters` pushes to the `admins` Socket.IO room. Kept free of model and
 * Socket.IO imports so models can use it without import cycles.
 */
export const adminBus = new EventEmitter();
adminBus.setMaxListeners(20);

/** Mongoose plugin-style hooks: any save / update on the schema emits ("change", kind, doc?). */
export function watchForAdmins(schema, kind) {
  const emit = (doc) => {
    try {
      adminBus.emit("change", kind, doc && doc._id ? { id: String(doc._id), status: doc.status ?? null } : null);
    } catch {
      /* never break a write */
    }
  };
  schema.post("save", (doc) => emit(doc));
  schema.post("findOneAndUpdate", (doc) => emit(doc));
  schema.post("updateOne", () => emit(null));
  schema.post("updateMany", () => emit(null));
}
