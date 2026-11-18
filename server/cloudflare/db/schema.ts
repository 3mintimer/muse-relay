import { sql } from 'drizzle-orm';
import { sqliteTable, integer, text, primaryKey, check, index } from 'drizzle-orm/sqlite-core';

export const relayHead = sqliteTable('relay_head', {
  id: integer('id').primaryKey(),
  revision: text('revision').notNull(),
}, table => [check('relay_head_singleton', sql`${table.id} = 1`)]);

export const relayChunks = sqliteTable('relay_chunks', {
  revision: text('revision').notNull(),
  ordinal: integer('ordinal').notNull(),
  data: text('data').notNull(),
}, table => [primaryKey({ columns: [table.revision, table.ordinal] })]);

export const relayBlobs = sqliteTable('relay_blobs', {
  objectKey: text('object_key').primaryKey(),
  createdAt: integer('created_at').notNull(),
  byteLength: integer('byte_length').notNull(),
  checkedAt: integer('checked_at').notNull().default(0),
}, table => [index('relay_blobs_collection').on(table.checkedAt, table.createdAt)]);
