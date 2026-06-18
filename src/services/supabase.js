const { createClient } = require('@supabase/supabase-js');

/**
 * Cliente singleton de Supabase con service_role key.
 * La key se lee directamente de process.env (no se expone vía config.js)
 * para limitar el acceso a este secreto.
 */
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: {
    persistSession: false
  },
  realtime: {
    params: {
      eventsPerSecond: 0
    }
  }
});

module.exports = { supabase };
