const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const jobId = process.argv[2];

if (!jobId) {
  console.error('❌ Error: Debes proporcionar el ID del Job.');
  console.error('Uso: node scripts/reset-job.js <job_id>');
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Error: SUPABASE_URL o SUPABASE_SERVICE_KEY no están configurados en el archivo .env.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function resetJob() {
  console.log(`⏳ Iniciando reseteo del Job: ${jobId}...`);

  try {
    // 1. Verificar si el job existe
    const { data: job, error: getError } = await supabase
      .from('jobs')
      .select('id, title, downloaded_at')
      .eq('id', jobId)
      .single();

    if (getError || !job) {
      console.error(`❌ Error: No se encontró el Job con ID "${jobId}" en la base de datos.`);
      process.exit(1);
    }

    console.log(`ℹ️ Job encontrado: "${job.title}" (downloaded_at actual: ${job.downloaded_at})`);

    // 2. Resetear registros de evidencia (local_path = null)
    console.log('⏳ Reseteando local_path de las evidencias en Supabase...');
    const { error: evError } = await supabase
      .from('evidence')
      .update({ local_path: null })
      .eq('job_id', jobId);

    if (evError) {
      throw new Error(`Error actualizando evidencias: ${evError.message}`);
    }

    // 3. Resetear el job (downloaded_at = null)
    console.log('⏳ Reseteando downloaded_at del Job en Supabase...');
    const { error: jobError } = await supabase
      .from('jobs')
      .update({ downloaded_at: null })
      .eq('id', jobId);

    if (jobError) {
      throw new Error(`Error actualizando el Job: ${jobError.message}`);
    }

    console.log('✅ ¡Reseteo completado con éxito!');
    console.log('🔄 El middleware volverá a procesar y descargar este trabajo automáticamente en el próximo ciclo de polling.');
  } catch (err) {
    console.error('❌ Ocurrió un error durante el reseteo:', err.message);
    process.exit(1);
  }
}

resetJob();
