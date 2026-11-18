import { sql } from 'drizzle-orm';
import { sqliteTable, integer, text, check, index } from 'drizzle-orm/sqlite-core';

export const feedbackReceipts = sqliteTable('feedback_receipts', {
  receipt: text('receipt').primaryKey(),
  kind: text('kind').notNull(),
  message: text('message').notNull(),
  share: integer('share').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  status: text('status').notNull().default('new'),
  issueUrl: text('issue_url'),
}, table => [
  index('feedback_receipts_created').on(table.createdAt),
  index('feedback_receipts_status_created').on(table.status, table.createdAt),
  check('feedback_kind', sql`${table.kind} IN ('idea', 'problem', 'question')`),
  check('feedback_share', sql`${table.share} IN (0, 1)`),
  check('feedback_message_length', sql`length(${table.message}) BETWEEN 10 AND 4000`),
  check('feedback_status', sql`${table.status} IN ('new', 'reviewed', 'issue', 'closed')`),
  check('feedback_issue_consent', sql`${table.issueUrl} IS NULL OR ${table.share} = 1`),
]);

export const feedbackLimits = sqliteTable('feedback_limits', {
  bucket: text('bucket').primaryKey(),
  count: integer('count').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('feedback_limits_expiry').on(table.expiresAt)]);
