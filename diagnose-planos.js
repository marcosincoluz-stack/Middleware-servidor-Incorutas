/**
 * Diagnóstico rápido: por qué los jobs pending sin plano no se suben.
 * Usa el índice cacheado (como el polling) + fallback profundo en misses.
 * Ejecutar en el servidor: node diagnose-planos.js
 */
process.env.API_TOKEN = process.env.API_TOKEN || 'diag-dummy';
if (!process.env.LOCK_PROVIDER) process.env.LOCK_PROVIDER = 'memory';
require('dotenv').config();

const path = require('path');
const { supabase } = require('./src/services/supabase');
const config = require('./src/config');
const { getProjectFolderIndex, invalidateProjectFolderIndex, listMatchingPdfs, listTopLevelPdfs, resolveFabricacionFolder } = require('./src/services/plano-uploader');

(async () => {
  console.log('=== Diagnóstico de planos pendientes ===\n');
  const { data: jobs, error } = await supabase
    .from('jobs').select('id, title, plans_url, status')
    .eq('status', 'pending').is('plans_url', null)
    .order('created_at', { ascending: true }).limit(300);
  if (error) { console.error('Error:', error.message); process.exit(1); }
  console.log('Jobs pending sin plano:', (jobs || []).length, '\n');

  const activosPath = path.join(config.TRABAJOS_BASE_PATH, '1ACTIVOS');
  console.log('Construyendo índice de', activosPath, '...');
  invalidateProjectFolderIndex();
  const index = await getProjectFolderIndex(activosPath);
  console.log('Índice:', index.size, 'carpetas.\n');

  const stats = { no_pcode: 0, no_folder: 0, index_miss_deep_found: 0, no_pdf: 0, no_match: 0, has_match: 0 };
  const noMatch = [], indexMiss = [];

  for (const job of (jobs || [])) {
    const m = (job.title || '').trim().match(/^(P\d+)/i);
    if (!m) { stats.no_pcode++; continue; }
    const pcode = m[1].toUpperCase();

    let folderPath = index.get(pcode);

    if (!folderPath) {
      // index miss: probar deep search (como el botón manual)
      let deep;
      try { deep = await resolveFabricacionFolder(job.title); } catch { deep = null; }
      if (deep) {
        stats.index_miss_deep_found++;
        const root = deep.includes('TERMINADOS') ? 'TERMINADOS' : (deep.includes('1ACTIVOS') ? '1ACTIVOS' : '???');
        indexMiss.push(`${pcode} | ${root} | ${(job.title||'').slice(0,55)}`);
        folderPath = deep;
      } else {
        stats.no_folder++;
        continue;
      }
    }

    const fabPath = path.join(folderPath, config.PLANO_SCAN_SUBFOLDER);
    let matching;
    try { matching = await listMatchingPdfs(fabPath, pcode); } catch { matching = []; }
    if (matching.length > 0) { stats.has_match++; continue; }

    let all;
    try { all = await listTopLevelPdfs(fabPath); } catch { all = []; }
    if (all.length === 0) { stats.no_pdf++; continue; }

    stats.no_match++;
    if (noMatch.length < 15) {
      noMatch.push({ pcode, title: (job.title||'').slice(0,50), pdfs: all.map(p=>p.name) });
    }
  }

  console.log('--- Resumen ---');
  console.log('  Sin P-code en título:', stats.no_pcode);
  console.log('  No FABRICACION folder (genuino):', stats.no_folder);
  console.log('  INDEX MISS (deep search lo encuentra, el index NO):', stats.index_miss_deep_found, stats.index_miss_deep_found > 0 ? '⚠️ BUG DEL INDEX' : '');
  console.log('  FABRICACION vacía (no_pdf):', stats.no_pdf);
  console.log('  PDFs pero NO empiezan por P-code (no_match):', stats.no_match);
  console.log('  PDFs que SÍ matchean (deberían subir):', stats.has_match, stats.has_match > 0 ? '⚠️ EL POLLING DEBERÍA ENCOLARLOS' : '');

  if (indexMiss.length > 0) {
    console.log('\n--- INDEX MISS (el polling no los encuentra en 1ACTIVOS; el deep search sí) ---');
    console.log('  P-code | root | título');
    indexMiss.forEach(s => console.log('  -', s));
  }
  if (noMatch.length > 0) {
    console.log('\n--- PDFs que NO empiezan por el P-code ---');
    noMatch.forEach(d => { console.log(`\n  ${d.pcode} - ${d.title}`); d.pdfs.forEach(n=>console.log(`      - ${n}`)); });
  }
  console.log('\n=== Fin ===');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
