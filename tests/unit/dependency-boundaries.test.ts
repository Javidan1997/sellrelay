import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cruise } from 'dependency-cruiser';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const config = require(join(root, '.dependency-cruiser.cjs'));

const probes: string[] = [];
function probe(relPath: string, source: string): string {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, source);
  probes.push(abs);
  return relPath;
}

async function violationsFor(files: string[]): Promise<string[]> {
  const prev = process.cwd();
  process.chdir(root);
  try {
    const result = await cruise(files, {
      ruleSet: { forbidden: config.forbidden },
      ...config.options,
      validate: true,
    });
    const output = result.output as { summary: { violations: { rule: { name: string } }[] } };
    return output.summary.violations.map((v) => v.rule.name);
  } finally {
    process.chdir(prev);
  }
}

afterEach(() => {
  for (const p of probes.splice(0)) rmSync(p, { force: true });
});

const target = () =>
  probe('packages/persistence/src/__probe_target.ts', 'export const target = 1;\n');

describe('dependency boundaries', () => {
  it('rejects a database client import from packages/core', async () => {
    const f = probe(
      'packages/core/src/__probe_forbidden_db.ts',
      "import pg from 'pg';\nexport const x = pg;\n",
    );
    expect(await violationsFor([f])).toContain('core-is-pure');
  });

  it('rejects core importing another workspace package', async () => {
    target();
    const f = probe(
      'packages/core/src/__probe_forbidden_pkg.ts',
      "import { target } from '../../persistence/src/__probe_target.ts';\nexport const x = target;\n",
    );
    expect(await violationsFor([f])).toContain('core-is-pure');
  });

  it('rejects the Shopify shell importing persistence', async () => {
    target();
    const f = probe(
      'apps/shopify/app/__probe_forbidden.ts',
      "import * as p from '../../../packages/persistence/src/__probe_target.ts';\nexport const x = p;\n",
    );
    expect(await violationsFor([f])).toContain('shopify-shell-is-thin');
  });

  it('rejects an adapter importing persistence', async () => {
    target();
    const f = probe(
      'packages/platforms/shopify/src/__probe_forbidden.ts',
      "import * as p from '../../../persistence/src/__probe_target.ts';\nexport const x = p;\n",
    );
    expect(await violationsFor([f])).toContain('no-infra-in-integrations');
  });

  it('accepts the real core package', async () => {
    expect(await violationsFor(['packages/core/src'])).toEqual([]);
  });
});
