import mongoose from "mongoose";
import { env } from "./env.js";

export async function connectDb() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.mongodbUri);
  console.log(`[db] connected → ${env.mongodbUri}`);
  await migrateUserEmailIndex();
}

/**
 * Phone-only accounts have no email. The original `email_1` index was unique over every
 * document (two missing emails would clash), so replace it once with the partial index the
 * User schema now declares.
 */
async function migrateUserEmailIndex() {
  try {
    const { User } = await import("../models/User.js");
    const indexes = await User.collection.indexes().catch(() => []);
    const legacy = indexes.find((i) => i.name === "email_1" && !i.partialFilterExpression);
    if (legacy) {
      await User.collection.dropIndex("email_1");
      console.log("[db] replaced users.email_1 with a partial unique index");
    }
    await User.createIndexes();
  } catch (err) {
    console.error("[db] user index migration failed:", err.message);
  }
}
