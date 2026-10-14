/**
 * A versão do PadoSpeak mora em vários arquivos (package.json da raiz e do cliente, tauri.conf.json e o
 * Cargo.toml do workspace) e todos têm de bater com a tag da release — se um ficar para trás, o
 * atualizador automático não enxerga a versão nova. Este script cuida disso (mesmo esquema do Pokeru):
 *
 *   npm run version:set 1.2.0           troca a versão em todos (e nos lockfiles)
 *   npm run version:set -- --check      confere se estão iguais entre si
 *   node scripts/version.mjs --check v1.2.0   confere se batem com a tag (usado no CI)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  pkg: join(root, 'package.json'),
  clientPkg: join(root, 'client', 'package.json'),
  lock: join(root, 'package-lock.json'),
  conf: join(root, 'desktop', 'src-tauri', 'tauri.conf.json'),
  cargo: join(root, 'Cargo.toml'),
  cargoLock: join(root, 'Cargo.lock'),
};

const read = (f) => readFileSync(f, 'utf8');
const json = (f) => JSON.parse(read(f));

/** Versão em cada arquivo, para comparar. */
export function versions() {
  const cargo = read(files.cargo).match(/\[workspace\.package\][^[]*?version = "([^"]+)"/s);
  return {
    'package.json': json(files.pkg).version,
    'client/package.json': json(files.clientPkg).version,
    'tauri.conf.json': json(files.conf).version,
    'Cargo.toml': cargo?.[1],
  };
}

function setVersion(next) {
  if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`versão inválida: ${next} (use X.Y.Z)`);
  const current = versions()['package.json'];
  for (const f of [files.pkg, files.clientPkg, files.conf]) {
    const data = json(f);
    data.version = next;
    writeFileSync(f, JSON.stringify(data, null, 2) + '\n');
  }
  // o package-lock guarda a versão da raiz e a de cada workspace
  const lock = json(files.lock);
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  if (lock.packages?.client) lock.packages.client.version = next;
  writeFileSync(files.lock, JSON.stringify(lock, null, 2) + '\n');
  writeFileSync(
    files.cargo,
    read(files.cargo).replace(/(\[workspace\.package\][^[]*?version = ")[^"]+(")/s, `$1${next}$2`),
  );
  let cl = read(files.cargoLock);
  for (const name of ['padospeak-server', 'padospeak-desktop']) {
    cl = cl.replace(`name = "${name}"\nversion = "${current}"`, `name = "${name}"\nversion = "${next}"`);
  }
  writeFileSync(files.cargoLock, cl);
  console.log(`✓ versão ${current} → ${next}`);
}

function check(tag) {
  const v = versions();
  const values = new Set(Object.values(v));
  if (values.size !== 1) {
    console.error('✗ as versões não batem:', v);
    process.exit(1);
  }
  const [only] = values;
  if (tag && tag.replace(/^v/, '') !== only) {
    console.error(`✗ a tag ${tag} não bate com a versão ${only} dos arquivos`);
    process.exit(1);
  }
  console.log(`✓ versão ${only}${tag ? ` (tag ${tag})` : ''}`);
}

const [arg, tag] = process.argv.slice(2);
if (arg === '--check') check(tag);
else if (arg) setVersion(arg);
else check();
