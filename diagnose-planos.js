/**
 * Diagnóstico: por qué los jobs pending sin plano no se suben.
 * Ejecutar en el servidor: node diagnose-planos.js
 * No modifica nada. Lista por job: no_folder / no_pdf / no_match (con nombres).
 */
process.env.API_TOKEN = process.env.API_TOKEN || 'diag-dummy';
if (!process.env.LOCK_PROVIDER) process.env.LOCK_PROVIDER = 'memory';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { supabase } = require('./src/services/supabase');
const config = require('./src/config');
const { resolveFabricacionFolder, listMatchingPdfs, listTopLevelPdfs } = require('./src/services/plano-uploader');

(async () => {
  console.log('=== Diagnóstico de planos pendientes ===\n');
  console.log('TRABAJOS_BASE_PATH:', config.TRABAJOS_BASE_PATH);
  console.log('PLANO_SCAN_SUBFOLDER:', config.PLANO_SCAN_SUBFOLDER);
  console.log('PLANO_MAX_PLANOS_PER_JOB:', config.PLANO_MAX_PLANOS_PER_JOB);
  console.log('');

  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, title, plans_url, status')
    .eq('status', 'pending')
    .is('plans_url', null)
    .order('created_at', { ascending: true })
    .limit(300);

  if (error) { console.error('Error Supabase:', error.message); process.exit(1); }

  console.log(`Jobs pending sin plano: ${(jobs || []).length}\n`);

  const stats = { no_pcode: 0, no_folder: 0, no_pdf: 0, no_match: 0, has_match: 0 };
  const noMatchDetails = [];
  const noFolderSamples = [];

  for (const job of (jobs || [])) {
    const match = (job.title || '').trim().match(/^(P\d+)/i);
    if (!match) { stats.no_pcode++; continue; }
    const pcode = match[1].toUpperCase();

    let fabPath;
    try {
      fabPath = await resolveFabricacionFolder(job.title);
    } catch (e) {
      fabPath = null;
    }

    if (!fabPath) {
      stats.no_folder++;
      if (noFolderSamples.length < 5) noFolderSamples.push(`${pcode} - ${(job.title||'').slice(0,50)}`);
      continue;
    }

    const matching = await listMatchingPdfs(fabPath, pcode);
    if (matching.length > 0) {
      stats.has_match++;
      continue;
    }

    const all = await listTopLevelPdfs(fabPath);
    if (all.length === 0) {
      stats.no_pdf++;
      continue;
    }

    stats.no_match++;
    if (noMatchDetails.length < 15) {
      noMatchDetails.push({
        pcode,
        title: (job.title || '').slice(0, 50),
        fabricacion: fabPath.replace(config.TRABAJOS_BASE_PATH, '...'),
        pdfs: all.map(p => p.name)
      });
    }
  }

  console.log('--- Resumen ---');
  console.log('  Sin P-code en título:', stats.no_pcode);
  console.log('  No FABRICACION folder (no_folder):', stats.no_folder);
  console.log('  FABRICACION vacía (no_pdf):', stats.no_pdf);
  console.log('  FABRICACION con PDFs PERO ninguno empieza por P-code (no_match):', stats.no_match);
  console.log('  FABRICACION con PDFs que SÍ matchean (has_match, deberían subir):', stats.has_match);

  if (noFolderSamples.length > 0) {
    console.log('\n--- Ejemplos sin carpeta FABRICACION (no_folder) ---');
    noFolderSamples.forEach(s => console.log('  -', s));
  }

  if (noMatchDetails.length > 0) {
    console.log('\n--- Detalle: PDFs que NO empiezan por el P-code (no_match) ---');
    console.log('  (Si estos son planos reales, hay que revisar la convención de nombres)');
    for (const d of noMatchDetails) {
      console.log(`\n  ${d.pcode} - ${d.title}`);
      console.log(`    Carpeta: ${d.fabricacion}`);
      console.log(`    PDFs encontrados (no matchean ${d.pcode}):`);
      d.pdfs.forEach(n => console.log(`      - ${n}`));
    }
  }

  console.log('\n=== Fin del diagnóstico ===');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
