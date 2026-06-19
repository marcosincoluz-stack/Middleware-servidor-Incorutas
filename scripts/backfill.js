const readline = require('readline');
const config = require('../src/config');
const { supabase } = require('../src/services/supabase');
const { processJobApproved } = require('../src/services/downloader');
const { retryFailedEvidences } = require('../src/services/downloader');
const { logger } = require('../src/utils/logger');

const BACKFILL_MAX_JOBS = parseInt(process.env.BACKFILL_MAX_JOBS, 10) || 100;

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const autoConfirm = args.includes('--yes') || args.includes('-y');
const jobIdArg = args.find(arg => arg.startsWith('--job-id='));
const jobId = jobIdArg ? jobIdArg.split('=')[1] : null;
const isRetryFailed = args.includes('--retry-failed');

async function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans);
  }));
}

async function runBackfill() {
  if (isRetryFailed) {
    return runRetryFailed();
  }

  console.log('\n========================================================================');
  console.log('🔄 SCRIPT DE DESCARGA RETROACTIVA (BACKFILL)');
  console.log(`Modo desarrollo: ${config.IS_DEV_MODE ? 'SÍ (HMAC omitido)' : 'NO (Producción)'}`);
  console.log(`Dry Run (Simulación): ${isDryRun ? '✅ ACTIVO' : '❌ INACTIVO'}`);
  console.log('========================================================================\n');

  let jobs = [];

  try {
    if (jobId) {
      console.log(`Buscando Job específico por ID: ${jobId}`);
      const { data, error } = await supabase
        .from('jobs')
        .select('id, title, status, downloaded_at, created_at')
        .eq('id', jobId)
        .single();

      if (error) throw error;
      if (!data) {
        console.error(`❌ No se encontró ningún Job con ID "${jobId}" en la base de datos.`);
        process.exit(1);
      }
      jobs = [data];
    } else {
      console.log('Consultando Jobs pendientes de descarga en la base de datos...');
      const { data, error } = await supabase
        .from('jobs')
        .select('id, title, status, downloaded_at, created_at')
        .in('status', ['approved', 'paid'])
        .is('downloaded_at', null)
        .order('created_at', { ascending: true })
        .limit(BACKFILL_MAX_JOBS);

      if (error) throw error;
      jobs = data || [];

      if (jobs.length >= BACKFILL_MAX_JOBS) {
        console.warn(`⚠️  Se alcanzó el límite de ${BACKFILL_MAX_JOBS} jobs. Puede haber más trabajos pendientes en la base de datos.\n`);
      }
    }
  } catch (err) {
    console.error('❌ Error consultando la base de datos de Supabase:', err.message);
    process.exit(1);
  }

  if (jobs.length === 0) {
    console.log('✅ No hay ningún Job pendiente de descarga.');
    process.exit(0);
  }

  console.log(`Se encontraron ${jobs.length} Jobs para procesar:`);
  jobs.forEach((job, index) => {
    console.log(`  [${index + 1}] ID: ${job.id} | Estado: ${job.status} | Creado: ${job.created_at} | Título: "${job.title}"`);
  });
  console.log('');

  if (isDryRun) {
    console.log('Simulación completada. No se ha descargado nada (modo --dry-run).');
    process.exit(0);
  }

  // Confirmación interactiva
  if (!autoConfirm) {
    const answer = await askQuestion('⚠️ ¿Desea proceder con la descarga de estos trabajos? (s/N): ');
    if (answer.toLowerCase() !== 's' && answer.toLowerCase() !== 'si') {
      console.log('❌ Operación cancelada por el usuario.');
      process.exit(0);
    }
  }

  console.log('\n🚀 Iniciando procesamiento secuencial...');

  let successCount = 0;
  let errorCount = 0;
  let totalDownloaded = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    console.log(`\n------------------------------------------------------------------------`);
    console.log(`[${i + 1}/${jobs.length}] Procesando Job: ${job.id} — "${job.title}"`);
    console.log(`------------------------------------------------------------------------`);

    try {
      const result = await processJobApproved(job.id, job.title);
      if (result && result.skipped === true) {
        console.log(`⏭️  Job omitido: ${result.reason}`);
      } else {
        const downloaded = result?.downloaded ?? 0;
        const skippedCount = (typeof result?.skipped === 'number') ? result.skipped : 0;
        console.log(`✅ Job procesado con éxito. Fotos descargadas: ${downloaded}, Omitidas: ${skippedCount}`);
        totalDownloaded += downloaded;
      }
      successCount++;
    } catch (err) {
      console.error(`❌ Error al procesar Job ${job.id}:`, err.message);
      errorCount++;
    }
  }

  console.log('\n========================================================================');
  console.log('📊 RESUMEN FINAL DEL BACKFILL');
  console.log('========================================================================');
  console.log(`Jobs procesados con éxito : ${successCount}`);
  console.log(`Jobs fallidos             : ${errorCount}`);
  console.log(`Total fotos descargadas   : ${totalDownloaded}`);
  console.log(`Estado global             : ${errorCount === 0 ? '✅ COMPLETADO' : '⚠️ PARCIAL (con errores)'}`);
  console.log('========================================================================\n');

  process.exit(errorCount === 0 ? 0 : 1);
}

async function runRetryFailed() {
  console.log('\n========================================================================');
  console.log('🔄 SCRIPT DE REINTENTO DE FOTOS FALLIDAS');
  console.log(`Modo desarrollo: ${config.IS_DEV_MODE ? 'SÍ (HMAC omitido)' : 'NO (Producción)'}`);
  console.log(`Dry Run (Simulación): ${isDryRun ? '✅ ACTIVO' : '❌ INACTIVO'}`);
  console.log('========================================================================\n');

  if (jobId) {
    console.log(`Buscando Job específico por ID: ${jobId}`);
    const { data, error } = await supabase
      .from('jobs')
      .select('id, title, status, downloaded_at, created_at')
      .eq('id', jobId)
      .single();

    if (error) throw error;
    if (!data) {
      console.error(`❌ No se encontró ningún Job con ID "${jobId}".`);
      process.exit(1);
    }
    if (!data.downloaded_at) {
      console.error(`❌ El Job ${jobId} aún no ha sido descargado. Use backfill normal en su lugar.`);
      process.exit(1);
    }

    if (isDryRun) {
      const { data: failedEvs, error: evErr } = await supabase
        .from('evidence')
        .select('id, url')
        .eq('job_id', jobId)
        .eq('type', 'photo')
        .is('local_path', null);
      if (evErr) throw evErr;
      console.log(`El Job "${data.title}" tiene ${(failedEvs || []).length} fotos fallidas.`);
      console.log('Simulación completada. No se ha reintentado nada (modo --dry-run).');
      process.exit(0);
    }

    const result = await retryFailedEvidences(jobId);
    console.log(`✅ Resultado: Reintentadas: ${result.retried}, Exitosas: ${result.succeeded}, Aún fallidas: ${result.stillFailed}`);
    process.exit(result.stillFailed > 0 ? 1 : 0);
  }

  console.log('Buscando Jobs descargados con fotos fallidas...');
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, title, downloaded_at')
    .not('downloaded_at', 'is', null)
    .order('downloaded_at', { ascending: false })
    .limit(BACKFILL_MAX_JOBS);

  if (error) throw error;

  if (!jobs || jobs.length === 0) {
    console.log('✅ No hay Jobs descargados en la base de datos.');
    process.exit(0);
  }

  const jobsWithFailures = [];
  for (const job of jobs) {
    const { data: failedEvs, error: evErr } = await supabase
      .from('evidence')
      .select('id')
      .eq('job_id', job.id)
      .eq('type', 'photo')
      .is('local_path', null)
      .limit(1);
    if (evErr) throw evErr;
    if (failedEvs && failedEvs.length > 0) {
      jobsWithFailures.push(job);
    }
  }

  if (jobsWithFailures.length === 0) {
    console.log('✅ No hay Jobs con fotos fallidas pendientes de reintento.');
    process.exit(0);
  }

  console.log(`Se encontraron ${jobsWithFailures.length} Jobs con fotos fallidas:`);
  jobsWithFailures.forEach((job, i) => {
    console.log(`  [${i + 1}] ID: ${job.id} | Descargado: ${job.downloaded_at} | Título: "${job.title}"`);
  });

  if (isDryRun) {
    console.log('\nSimulación completada. No se ha reintentado nada (modo --dry-run).');
    process.exit(0);
  }

  if (!autoConfirm) {
    const answer = await askQuestion('⚠️ ¿Desea reintentar las fotos fallidas de estos trabajos? (s/N): ');
    if (answer.toLowerCase() !== 's' && answer.toLowerCase() !== 'si') {
      console.log('❌ Operación cancelada por el usuario.');
      process.exit(0);
    }
  }

  console.log('\n🚀 Iniciando reintento secuencial...');

  let totalRetried = 0;
  let totalSucceeded = 0;
  let totalStillFailed = 0;
  let errorCount = 0;

  for (let i = 0; i < jobsWithFailures.length; i++) {
    const job = jobsWithFailures[i];
    console.log(`\n------------------------------------------------------------------------`);
    console.log(`[${i + 1}/${jobsWithFailures.length}] Reintentando Job: ${job.id} — "${job.title}"`);

    try {
      const result = await retryFailedEvidences(job.id);
      totalRetried += result.retried;
      totalSucceeded += result.succeeded;
      totalStillFailed += result.stillFailed;
      console.log(`  Reintentadas: ${result.retried}, Exitosas: ${result.succeeded}, Aún fallidas: ${result.stillFailed}`);
    } catch (err) {
      console.error(`❌ Error al reintentar Job ${job.id}: ${err.message}`);
      errorCount++;
    }
  }

  console.log('\n========================================================================');
  console.log('📊 RESUMEN FINAL DEL REINTENTO');
  console.log('========================================================================');
  console.log(`Jobs procesados       : ${jobsWithFailures.length}`);
  console.log(`Jobs con error        : ${errorCount}`);
  console.log(`Fotos reintentadas    : ${totalRetried}`);
  console.log(`Fotos recuperadas     : ${totalSucceeded}`);
  console.log(`Fotos aún fallidas    : ${totalStillFailed}`);
  console.log(`Estado global         : ${totalStillFailed === 0 ? '✅ COMPLETADO' : '⚠️ PARCIAL (con fotos aún fallidas)'}`);
  console.log('========================================================================\n');

  process.exit(totalStillFailed > 0 || errorCount > 0 ? 1 : 0);
}

runBackfill().catch((err) => {
  console.error('❌ Error inesperado en el proceso de backfill:', err);
  process.exit(1);
});
