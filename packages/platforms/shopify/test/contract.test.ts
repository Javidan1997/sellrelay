import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClientSchema, buildSchema, parse, validate, type GraphQLSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { ALL_DOCUMENTS, BULK_INVENTORY_QUERY, BULK_PRODUCTS_QUERY } from '../src/index.ts';

/**
 * Contract test against the official Admin GraphQL schema for the pinned version.
 * Download it with `pnpm shopify:schema` (requires network access to shopify.dev).
 * When the schema is absent the test is SKIPPED and reported as "Not run" in the gate report.
 */
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const sdl = join(dir, 'admin-2026-10.graphql');
const introspection = join(dir, 'admin-2026-10.json');

function loadSchema(): GraphQLSchema | null {
  if (existsSync(sdl)) return buildSchema(readFileSync(sdl, 'utf8'));
  if (existsSync(introspection)) {
    const json = JSON.parse(readFileSync(introspection, 'utf8'));
    return buildClientSchema(json.data ?? json);
  }
  return null;
}

const schema = loadSchema();

describe('Admin GraphQL documents', () => {
  it('parse as valid GraphQL syntax', () => {
    for (const [name, doc] of Object.entries(ALL_DOCUMENTS))
      expect(() => parse(doc), name).not.toThrow();
  });

  it('bulk queries respect the two-level connection nesting limit', () => {
    for (const q of [BULK_PRODUCTS_QUERY, BULK_INVENTORY_QUERY])
      expect((q.match(/edges/g) ?? []).length).toBe(2);
  });

  it.skipIf(!schema)('validate against the official 2026-10 Admin schema', () => {
    for (const [name, doc] of Object.entries(ALL_DOCUMENTS)) {
      const errors = validate(schema!, parse(doc));
      expect(
        errors.map((e) => e.message),
        name,
      ).toEqual([]);
    }
  });
});
