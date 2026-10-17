// Gera desktop/src-tauri/src/games.tsv, a lista de jogos do "Jogando <jogo>": executável → nome, a partir
// da lista pública de jogos detectáveis do Discord (a mesma que ele usa para o status de jogo).
//
//   node scripts/detectable-games.mjs            baixa a lista de discord.com
//   node scripts/detectable-games.mjs lista.json usa um arquivo já baixado
//
// Cada linha: `caminho\tnome`. O caminho é o fim do caminho do executável, em minúsculas e com `\`
// (`garrysmod\hl2.exe` vale para `...\GarrysMod\hl2.exe`). Ficam de fora os launchers e os nomes de
// arquivo genéricos demais (`game.exe`, `client.exe`…) ou que aparecem em vários jogos, quando não
// vêm com a pasta junto: eles marcariam o jogo errado.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://discord.com/api/v9/applications/detectable';
const OUT = fileURLToPath(new URL('../desktop/src-tauri/src/games.tsv', import.meta.url));
/** Nomes que vários programas usam: só valem com a pasta junto. */
const GENERIC = new Set([
  'game.exe', 'main.exe', 'client.exe', 'launcher.exe', 'start.exe', 'play.exe', 'run.exe', 'setup.exe', 'app.exe',
  'engine.exe', 'gameclient.exe', 'clientg.exe', 'build.exe', 'default.exe', 'app_main.exe', 'autorun.exe',
  'nw.exe', 'electron.exe', 'dosbox.exe', 'steamrun.exe', 'graphicsconfig.exe', 'javaw.exe', 'java.exe',
  'python.exe', 'pythonw.exe', 'game_x64.exe', 'win64.exe', 'project.exe', 'unitycrashhandler64.exe',
  'unitycrashhandler32.exe', 'crashreportclient.exe', 'ue4game.exe', 'ue4game-win64-shipping.exe',
  'game-win64-shipping.exe', 'client-win64-shipping.exe', 'shipping.exe', 'x64.exe', 'x86.exe', 'bin.exe',
]);

const apps = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : await (await fetch(SOURCE)).json();
const rows = [];
for (const app of apps) {
  const name = String(app.name || '').replace(/[\t\r\n]+/g, ' ').trim();
  if (!name) continue;
  for (const ex of app.executables || []) {
    if (ex.os !== 'win32' || ex.is_launcher) continue;
    const path = String(ex.name).toLowerCase().replace(/^>/, '').replaceAll('/', '\\').replace(/^\\+/, '').trim();
    if (path) rows.push([path, name]);
  }
}
// Quantos jogos usam cada caminho e cada nome de arquivo.
const byPath = new Map();
const byFile = new Map();
for (const [path, name] of rows) {
  (byPath.get(path) ?? byPath.set(path, new Set()).get(path)).add(name);
  const file = path.split('\\').pop();
  (byFile.get(file) ?? byFile.set(file, new Set()).get(file)).add(name);
}
const out = new Map();
for (const [path, names] of byPath) {
  if (names.size > 1) continue; // o mesmo caminho em jogos diferentes
  const bare = !path.includes('\\');
  if (bare && (GENERIC.has(path) || byFile.get(path).size >= 3)) continue;
  out.set(path, [...names][0]);
}
const lines = [...out].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, n]) => `${p}\t${n}`);
writeFileSync(
  OUT,
  `# Gerado por scripts/detectable-games.mjs a partir de ${SOURCE} (${new Date().toISOString().slice(0, 10)}). Não edite à mão.\n${lines.join('\n')}\n`,
);
console.log(`${lines.length} executáveis de ${new Set(out.values()).size} jogos → ${OUT}`);
