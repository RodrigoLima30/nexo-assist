/** Apaga os bancos locais; no próximo start os dados de exemplo são recriados. */
import { rmSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../server/config';

if (existsSync(config.dataDir)) {
  for (const f of readdirSync(config.dataDir)) {
    if (/\.db(-wal|-shm)?$/.test(f)) rmSync(path.join(config.dataDir, f));
  }
}
console.log(`Bancos removidos de ${config.dataDir}. Pare os servidores antes de rodar este comando.`);
